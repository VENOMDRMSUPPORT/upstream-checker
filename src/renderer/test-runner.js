// Adaptive hedging and per-model retry orchestration, independent of DOM and application globals.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.runner = {
  create(deps) {
    'use strict';
    const { getSettings, isAborted, isMedia, isDecision, kindLimits, nextRequestId,
      cancelRequest, attemptOnce, onProgress, newUlid, sleep, retryDelay } = deps;
    const getRunningResult = deps.getRunningResult || (() => deps.runningResult);
    const policy = deps.policy;
    const { soonestKeyAvailable, waitForAnyKey, keysFor, isKeySpentFor, clearKeySpent,
      readQuotaError, markKeySpent, isEntitlementDenial, isRateLimit, learnRateLimit,
      coolKeyDown, hasFreeKeyBudget, formatIn } = policy;
    const { resultRank } = deps.responses;
    const STREAM_HEDGE = 2;
    const RETRYABLE_STATUS = new Set([502, 503, 504]);
    // non-empty pass > empty pass > fail

    // Fire `count` parallel attempts; resolve as soon as one returns a non-empty pass
    // (cancelling the rest). If none do, wait for all and resolve with the best result.
    function raceAttempts(model, provider, stream, count, tags = {}) {
      return new Promise((resolve) => {
        const ids = [];
        let pending = count;
        let best = null;
        let settled = false;
        const cancelRest = () => ids.forEach((id) => cancelRequest(id, 'hedge_lost'));

        for (let i = 0; i < count; i++) {
          const id = nextRequestId({ ...tags, hedgeIndex: i });
          ids.push(id);
          attemptOnce(model, provider, stream, id).then((r) => {
            pending -= 1;
            if (settled) return;
            if (r.status === 'pass' && !r.isEmpty) {
              settled = true;
              cancelRest();
              resolve(r);
              return;
            }
            if (!r.cancelled && (!best || resultRank(r) > resultRank(best))) best = r;
            if (pending === 0) {
              settled = true;
              resolve(best || r);
            }
          });
        }
      });
    }

    // Adaptive non-streaming hedge: start with one request; if it is slow, fire
    // another parallel attempt every HEDGE_STEP_MS (up to HEDGE_MAX). The first
    // non-empty answer wins (cancel the rest). An empty 200 is deterministic per
    // model, so we stop escalating once we see one and resolve with the best result.
    // A hard per-kind deadline prevents a pathologically slow model from hanging.
    function adaptiveNonStream(model, provider, tags = {}) {
      const { deadline, hedge } = kindLimits(model.kind);
      const maxAttempts = hedge ? Math.max(1, getSettings().hedgeMax) : 1;
      return new Promise((resolve) => {
        const ids = [];
        let settled = false;
        let best = null;
        let inflight = 0;
        let launched = 0;
        let stop = false; // stop launching new attempts (saw an empty, or aborted)
        let stepTimer = null;
        let deadlineTimer = null;

        // Why the attempts still running are cut, for the request log: a winner
        // makes them hedge losers, Stop is the user's, and the per-kind deadline
        // is recorded as a timeout.
        const cancelAll = (reason) => ids.forEach((id) => cancelRequest(id, reason));
        const finish = (r, reason = 'hedge_lost') => {
          if (settled) return;
          settled = true;
          clearTimeout(stepTimer);
          clearTimeout(deadlineTimer);
          cancelAll(reason);
          resolve(r);
        };

        // An extra attempt is only worth firing if a key can take it right now.
        // Hedging exists to get an answer sooner; queueing behind a per-minute cap to
        // send one does the opposite, and spends a slot the models still waiting need.
        const budgetFree = () => hasFreeKeyBudget(provider, model);

        const launch = (escalation = false) => {
          if (settled || stop || isAborted() || launched >= maxAttempts) return;
          if (escalation && !budgetFree()) {
            // No room to widen; check again after the usual interval.
            stepTimer = setTimeout(() => launch(true), getSettings().hedgeStepMs);
            return;
          }
          launched += 1;
          inflight += 1;
          const id = nextRequestId({ ...tags, hedgeIndex: launched - 1 });
          ids.push(id);
          attemptOnce(model, provider, false, id).then((r) => {
            inflight -= 1;
            if (settled) return;
            // Stop was pressed. Every attempt comes back `cancelled`, which sets
            // neither `stop` nor `best` — without this the promise would hang until
            // the 75s deadline and "Stopping..." would sit there for over a minute.
            if (isAborted()) return finish(best || { status: 'fail', response: 'Aborted', time: 0, tokens: 0 }, 'stop');
            if (r.status === 'pass' && !r.isEmpty) return finish(r); // fastest correct wins
            if (!r.cancelled && (!best || resultRank(r) > resultRank(best))) best = r;
            // A completed non-win result (empty or failure) means the model isn't just
            // slow — stop fanning out. Escalation is only for slowness (pending attempts);
            // an empty goes to streaming and a failure (e.g. 429) is retried with backoff
            // by testModel, so we must not keep firing requests at it here.
            if (!r.cancelled) {
              stop = true;
              clearTimeout(stepTimer);
            }
            if (inflight === 0 && (stop || isAborted() || launched >= maxAttempts)) finish(best);
          });
          if (!stop && launched < maxAttempts) stepTimer = setTimeout(() => launch(true), getSettings().hedgeStepMs);
        };

        deadlineTimer = setTimeout(
          () => finish(best || { status: 'fail', response: 'Timed out', time: deadline, tokens: 0, statusCode: 0, timedOut: true }, 'deadline'),
          deadline
        );

        launch();
      });
    }

    // ============================================
    // Test a single model — adaptive hedge, handles reasoning, empty, rate limits
    // ============================================
    async function testModel(model, provider) {
      // One id per testModel call, so the log pages can draw its retry chain.
      const testGroup = newUlid();
      let transientRetries = 0;
      let emptyRetried = false;
      let rateLimitWaits = 0;
      let rounds = 0;

      // `time` is only the winning attempt, so a 502 retried twice still reports
      // ~0.3s. Carrying the round count lets the table show that it took more than
      // one go instead of presenting the last attempt as the whole story.
      const done = (r) => ({ ...r, attempts: rounds });

      // The wall clock this one model has consumed. Every retry layer inside the
      // loop below multiplies — rate-limit windows, transient retries each carrying
      // a fresh deadline, empty recovery — and without a ceiling a single model can
      // hold the whole run for minutes. 0 in the setting turns the budget off, and
      // a generator sits it out entirely: its deadline is minutes by design, and a
      // 90s ceiling would call every working video model broken.
      const budgetMs = isMedia(model) ? 0 : getSettings().perModelBudgetMs;
      const startedAt = Date.now();
      const budgetLeft = () =>
        budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : Infinity;
      // The verdict when the ceiling is hit. Any key-fact flags already on `r`
      // (quota, entitlement) are kept: those stay facts about the key, and the
      // health writer below keeps excluding them.
      const outOfBudget = (r, why) => done({
        ...(r || { status: 'fail', time: 0, tokens: 0 }),
        status: 'fail',
        tokens: r?.tokens ?? 0,
        budgetAborted: true,
        response: `Gave up after ${Math.round((Date.now() - startedAt) / 1000)}s — ${why}`,
      });

      while (true) {
        // Every key may still be cooling from an earlier model's 429.
        const soonest = soonestKeyAvailable(provider, model);
        if (soonest > Date.now()) {
          // Waiting out the window counts against the budget: a model that needs
          // more waiting than the budget allows reports that instead of holding
          // the run hostage.
          if (budgetLeft() < soonest - Date.now()) {
            return outOfBudget(null, 'every key is rate limited past the time budget');
          }
          onProgress(model, { status: 'running', waiting: true, time: null, tokens: null });
          await waitForAnyKey(provider, model);
          onProgress(model, getRunningResult());
        }
        if (isAborted()) return done({ status: 'fail', response: 'Aborted', time: 0, tokens: 0 });

        // Every key that could serve this model was already refused it for a spent
        // quota: say so, and when the first one resets, without sending anything.
        const candidates = keysFor(provider, model);
        if (candidates.length > 0 && candidates.every((k) => isKeySpentFor(k, model.id))) {
          const resets = candidates.map((k) => k.quotaSpent.until).filter(Boolean);
          const next = resets.length ? Math.min(...resets) : null;
          return done({
            status: 'fail', time: 0, tokens: 0, quotaSpent: true,
            response: `Quota used up for this model${next ? ` — resets ${new Date(next).toLocaleString()} (in ${formatIn(next)})` : ''}`,
          });
        }
        rounds += 1;

        const r = await adaptiveNonStream(model, provider, { testGroup, attempt: rounds });

        // A key that serves a model it had been refused has quota again (reset
        // early, topped up). Serving another model says nothing: that one may
        // draw on a different allowance.
        if (r.status === 'pass' && r.keyId && isKeySpentFor(provider.keys.find((k) => k.id === r.keyId), model.id)) {
          clearKeySpent(provider.id, r.keyId);
        }

        if (r.status === 'pass' && !r.isEmpty) return done(r);

        if (r.status === 'pass' && r.isEmpty) {
          // Generators and decision models don't stream text, so the SSE recovery
          // below would just buy a second generation (or decision) for nothing.
          if (isMedia(model) || isDecision(model)) return done(r);
          // Empty on the non-streaming endpoint: some models (byNara event-stream)
          // deliver content only over SSE — try streaming. But only when a key has
          // a free slot: the recovery fires parallel attempts, and racing them into
          // a per-minute cap spends slots the models still waiting need.
          if (isAborted()) return done(r);
          if (budgetLeft() <= 0) return outOfBudget(r, 'time budget spent before streaming recovery');
          const streamed = hasFreeKeyBudget(provider, model)
            ? await raceAttempts(model, provider, true, STREAM_HEDGE, { testGroup, attempt: rounds })
            : r;
          if (streamed.status === 'pass' && !streamed.isEmpty) return done(streamed);
          // Both empty. Empty can be flaky, so retry the whole model once.
          if (!emptyRetried && !isAborted()) {
            if (budgetLeft() <= 0) return outOfBudget(r, 'time budget spent before the empty retry');
            emptyRetried = true;
            await sleep(500);
            continue;
          }
          return done(r);
        }

        // The key's quota for this model is spent. It is remembered (until the
        // reset) so later runs don't ask again, and this model moves on to another
        // key if there is one. Checked before the entitlement rule below, which
        // would forget it at the end of the run.
        const quota = r.status === 'fail' && r.keyId ? readQuotaError(provider, r) : null;
        if (quota && !isAborted()) {
          await markKeySpent(provider.id, r.keyId, { ...quota, status: r.statusCode }, model.id);
          if (keysFor(provider, model).some((k) => !isKeySpentFor(k, model.id))) {
            if (budgetLeft() <= 0) return outOfBudget(r, 'time budget spent before trying the next key');
            continue;
          }
          return done({ ...r, quotaSpent: true });
        }

        // This key isn't entitled to this model. Remember that and try another key
        // if one is left — a model the account can actually reach must not be
        // recorded as down because the wrong key asked for it.
        if (isEntitlementDenial(r) && r.keyId && !isAborted()) {
          const before = keysFor(provider, model).length;
          policy.deny(r.keyId, model.id);
          const after = keysFor(provider, model).filter(
            (k) => !policy.isDenied(k.id, model.id)
          ).length;
          if (after > 0 && after < before) {
            // Another key may be entitled — but not past the budget.
            if (budgetLeft() <= 0) return outOfBudget(r, 'time budget spent before trying the next key');
            continue; // another key may be entitled
          }
          return done({ ...r, entitlementDenied: true });
        }

        // Rate limited. Cool that key down and try again — with a second key the run
        // simply moves onto it, and only waits when every key is capped. Being
        // throttled never gets recorded as the model's failure.
        if ((isRateLimit(r) || r.allKeysCooling) && rateLimitWaits < getSettings().maxRateLimitWaits && !isAborted()) {
          if (budgetLeft() <= 0) {
            // Being throttled is a fact about the run's own pacing, so this carries
            // allKeysCooling when that is what it was: not a model verdict either way.
            return outOfBudget({ ...(r.allKeysCooling ? { allKeysCooling: true } : {}), statusCode: r.statusCode },
              `still rate limited after ${rateLimitWaits} window${rateLimitWaits === 1 ? '' : 's'}`);
          }
          rateLimitWaits += 1;
          if (r.keyId) {
            if (isRateLimit(r)) learnRateLimit(provider, r.keyId);
            coolKeyDown(r.keyId, r);
          }
          continue;
        }
        if (isRateLimit(r)) {
          return done({
            ...r,
            response: `Still rate limited after ${rateLimitWaits} window${rateLimitWaits === 1 ? '' : 's'} — ${r.response}`,
          });
        }

        // A failure. Retry on transient errors (5xx/network) with backoff — except for
        // a decision call: it carries no idempotency guarantee, so a lost reply may
        // already have been served and billed, and a retry would pay for it twice.
        const retryable =
          !isDecision(model) && ((r.statusCode && RETRYABLE_STATUS.has(r.statusCode)) || r.networkError);
        if (retryable && transientRetries < getSettings().maxTestRetries && !isAborted()) {
          if (budgetLeft() <= 0) return outOfBudget(r, 'time budget spent before the transient retry');
          await sleep(retryDelay(transientRetries));
          transientRetries++;
          continue;
        }
        return done(r);
      }
    }
    return { raceAttempts, adaptiveNonStream, testModel };
  },
};
