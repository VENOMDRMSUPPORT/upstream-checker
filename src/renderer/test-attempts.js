// Provider test requests — chat, media and decision routes through injected IPC only.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.attempts = {
  create(deps) {
    'use strict';
    const { getSettings, getPrompt, isAborted, defaultPrompt, isMedia, isDecision, kindLimits,
      request, routeTestTags, getRequestTags, nextRequestId, sleep, tokenLimitField,
      swapTokenLimitField, omitReasoning, disableReasoning, reasoningRejected, observeUsage, getAdapter } = deps;
    const { pickKey, waitForSlot } = deps.policy;
    const { usageTokens, parseRetryAfter, failFromResponse, transportFailure, authHeaders,
      isMissingRoute, findAssetUrl, extractMediaUrl, parseChatCompletion, parseStreamedCompletion, buildEmptyResult } = deps.responses;
    const mediaViaChat = new Set();
    const mediaRouteKey = (providerId, kind) => `${providerId}|${kind}`;

    // Whether a failed generation call means "this route does not exist here" (fall
    // back to chat) rather than "this model failed" (report it). A 404 that names
    // the model is a missing model, not a missing route.

    // First link to an asset anywhere in a JSON reply. Field names differ per
    // gateway (url, video_url, output[0], data[0].url...), so keys that mention a
    // url are searched before the rest.

    // The asset link inside a chat reply, markdown image syntax included.

    // Asks the host what a link serves without downloading it: HEAD first, then a
    // one-byte ranged GET for hosts (signed CDN links, mostly) that refuse HEAD.
    // true/false is a verdict; null means the host would not say, and the caller
    // falls back to the link itself.
    async function verifyAsset(url, kind, headers = {}, requestId = null) {
      if (!getSettings().verifyAssets || !url) return null;
      const want = kind === 'video' ? 'video/' : 'image/';
      if (/^data:/i.test(url)) return url.slice(5).toLowerCase().startsWith(want);
      for (const [method, extra] of [['HEAD', {}], ['GET', { Range: 'bytes=0-0' }]]) {
        let res;
        try {
          // Logged under the attempt that produced the link (requestId's tags).
          res = await request({ url, method, headers: { ...headers, ...extra }, timeoutMs: 20000, ...routeTestTags(requestId) });
        } catch (_) {
          continue;
        }
        if (res.networkError || res.cancelled) continue;
        if ([403, 405, 501].includes(res.status)) continue;
        if (res.status >= 400) return false; // a dead link is not a working generator
        const type = String(res.headers?.['content-type'] || '').toLowerCase();
        if (!type || type.startsWith('application/octet-stream')) return null;
        return type.startsWith(want);
      }
      return null;
    }

    // Result fields for a generated asset: what the response column shows and, when
    // the check could be made, whether the link really serves that kind of media.
    async function assetResult(url, kind, headers, requestId = null) {
      const verified = await verifyAsset(url, kind, headers, requestId);
      const shown = /^data:/i.test(url) ? `Inline ${kind} · ${Math.round((url.length * 3) / 4 / 1024)} KB` : url;
      return typeof verified === 'boolean' ? { response: shown, assetVerified: verified } : { response: shown };
    }

    async function attemptImage(model, provider, key, requestId) {
      const { deadline } = kindLimits('image');
      const res = await request({
        url: `${provider.baseUrl}${provider.imageEndpoint || '/images/generations'}`,
        method: 'POST',
        headers: authHeaders(key.key),
        body: JSON.stringify({ model: model.id, prompt: getSettings().imagePrompt, n: 1 }),
        requestId,
        timeoutMs: deadline,
        ...routeTestTags(requestId),
      });
      const lost = transportFailure(res, key.id);
      if (lost) return lost;
      if (res.status !== 200) {
        const f = failFromResponse(res, key.id);
        return isMissingRoute(res, f.response) ? { routeMissing: true } : f;
      }

      const data = JSON.parse(res.body);
      const item = data.data?.[0] || {};
      const base = { keyId: key.id, status: 'pass', isEmpty: false, time: res.elapsed, tokens: usageTokens(data.usage) };
      if (item.b64_json) {
        return { ...base, response: `Inline image · ${Math.round((item.b64_json.length * 3) / 4 / 1024)} KB`, assetInline: true };
      }
      const url = item.url || findAssetUrl(data);
      if (!url) return { ...buildEmptyResult(data.usage || {}, res.elapsed), response: 'No image returned by provider', keyId: key.id };
      return { ...base, ...(await assetResult(url, 'image', undefined, requestId)) };
    }

    const JOB_DONE = new Set(['completed', 'succeeded', 'success', 'done', 'finished', 'ready']);
    const JOB_FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired']);

    // Video is asynchronous: the create call returns a job, which is polled until it
    // finishes. A gateway that answers synchronously with the asset skips the polling.
    async function attemptVideo(model, provider, key, requestId) {
      const { deadline } = kindLimits('video');
      const endpoint = `${provider.baseUrl}${provider.videoEndpoint || '/videos'}`;
      const started = Date.now();
      const res = await request({
        url: endpoint,
        method: 'POST',
        headers: authHeaders(key.key),
        body: JSON.stringify({ model: model.id, prompt: getSettings().videoPrompt }),
        requestId,
        timeoutMs: deadline,
        ...routeTestTags(requestId),
      });
      const lost = transportFailure(res, key.id);
      if (lost) return lost;
      if (res.status < 200 || res.status >= 300) {
        const f = failFromResponse(res, key.id);
        return isMissingRoute(res, f.response) ? { routeMissing: true } : f;
      }

      let job = JSON.parse(res.body);
      const elapsed = () => Date.now() - started;
      const fail = (response, extra = {}) => ({ status: 'fail', response, time: elapsed(), tokens: 0, keyId: key.id, ...extra });

      while (true) {
        const state = String(job.status || '').toLowerCase();
        if (JOB_FAILED.has(state)) {
          return fail(`Video job ${state}${job.error ? `: ${job.error.message || job.error}` : ''}`);
        }
        const url = findAssetUrl(job);
        const done = JOB_DONE.has(state);
        if (done || (url && !state)) {
          const pass = { keyId: key.id, status: 'pass', isEmpty: false, time: elapsed(), tokens: usageTokens(job.usage) };
          if (url) return { ...pass, ...(await assetResult(url, 'video', undefined, requestId)) };
          // Finished without a link: the OpenAI shape serves the file from the job.
          const contentUrl = `${endpoint}/${encodeURIComponent(job.id)}/content`;
          const verified = await verifyAsset(contentUrl, 'video', { Authorization: `Bearer ${key.key}` }, requestId);
          return { ...pass, response: `Video ready · job ${job.id}`, ...(typeof verified === 'boolean' ? { assetVerified: verified } : {}) };
        }
        if (!job.id) return fail('Video job returned neither an id nor an asset');
        if (isAborted()) return fail('Aborted', { cancelled: true });
        if (elapsed() >= deadline) return fail(`Timed out while the video was ${state || 'pending'}`, { statusCode: 0, timedOut: true });

        await sleep(Math.max(1000, getSettings().videoPollMs));
        // A poll belongs to the same attempt: it carries the create call's tags.
        const pollId = nextRequestId(getRequestTags(requestId) || null);
        const poll = await request({
          url: `${endpoint}/${encodeURIComponent(job.id)}`,
          method: 'GET',
          headers: authHeaders(key.key),
          requestId: pollId,
          timeoutMs: 30000,
          ...routeTestTags(pollId),
        });
        if (poll.cancelled) return fail('cancelled', { cancelled: true });
        if (poll.networkError) continue; // one lost poll is not a failed job
        if (poll.status !== 200) return { ...failFromResponse(poll, key.id), time: elapsed() };
        job = JSON.parse(poll.body);
      }
    }

    // A decision model scores a typed question against a state. The wire protocol —
    // body shape and answer parsing — belongs to the provider module (see the
    // decision hooks in src/renderer/providers/*.js); this only drives the request
    // and hands the score on for judging against decisionThreshold.
    async function attemptDecision(model, provider, key, requestId) {
      const adapter = getAdapter(provider.id);
      if (!provider.decisionEndpoint || !adapter || !adapter.decisionProbe || !adapter.readDecisionAnswer) {
        return { status: 'fail', response: `${provider.name} declares no decision endpoint`, time: 0, tokens: 0, keyId: key.id };
      }
      const { deadline } = kindLimits('decision');
      const body = adapter.decisionProbe(model, { state: getSettings().decisionState, question: getSettings().decisionQuestion });
      const res = await request({
        url: `${provider.baseUrl}${provider.decisionEndpoint}`,
        method: 'POST',
        headers: authHeaders(key.key),
        body: JSON.stringify(body),
        requestId,
        timeoutMs: deadline,
        ...routeTestTags(requestId),
      });
      const lost = transportFailure(res, key.id);
      if (lost) return lost;
      if (res.status !== 200) return failFromResponse(res, key.id);

      const data = JSON.parse(res.body);
      const answered = adapter.readDecisionAnswer(data);
      if (!answered) {
        return { ...buildEmptyResult(data.usage || {}, res.elapsed), response: 'No probability returned by provider', keyId: key.id };
      }
      return {
        keyId: key.id,
        status: 'pass',
        isEmpty: false,
        response: answered.response,
        decisionScore: answered.score,
        time: res.elapsed,
        tokens: usageTokens(data.usage),
      };
    }

    // One single request. Returns a pass (content), an empty pass, or a fail carrying
    // statusCode/retryAfter so the caller can decide whether to retry.
    async function attemptOnce(model, provider, stream, requestId) {
      const key = pickKey(provider, model);
      if (!key) return { status: 'fail', response: 'All keys are rate limited', time: 0, tokens: 0, allKeysCooling: true };
      await waitForSlot(provider, key);
      if (isAborted()) return { status: 'fail', response: 'Aborted', time: 0, tokens: 0, cancelled: true };

      try {
        if (isDecision(model)) return await attemptDecision(model, provider, key, requestId);
        if (isMedia(model) && !mediaViaChat.has(mediaRouteKey(provider.id, model.kind))) {
          const tester = model.kind === 'video' ? attemptVideo : attemptImage;
          const r = await tester(model, provider, key, requestId);
          if (!r.routeMissing) return r;
          mediaViaChat.add(mediaRouteKey(provider.id, model.kind));
        }
      } catch (err) {
        return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0,
                 cancelled: !!err.cancelled, networkError: !err.cancelled, keyId: key.id };
      }
      return attemptChat(model, provider, stream, requestId, key);
    }

    // Chat completion — also the fallback route for a generator whose provider has
    // no dedicated image or video endpoint.
    async function attemptChat(model, provider, stream, requestId, key) {
      const apiKey = key.key;
      const baseUrl = provider.baseUrl;
      // reasoning_effort:'low' is sent to every model — it is a no-op on non-reasoning
      // models and clamps safely, but it makes reasoning-heavy models think briefly
      // instead of burning time on a deep chain for a trivial prompt. ('minimal' is
      // NOT safe — some models return empty under it — so 'low' is the floor.)
      const media = isMedia(model);
      const payload = {
        model: model.id,
        messages: [{
          role: 'user',
          content: model.kind === 'video' ? getSettings().videoPrompt : media ? getSettings().imagePrompt : getPrompt() || defaultPrompt,
        }],
        stream: !!stream,
      };
      // Newer OpenAI-compatible gateways rejected max_tokens in favour of
      // max_completion_tokens. Which one a provider accepts is learned from its own
      // 400 and remembered, so the swap costs one request per provider, once.
      payload[tokenLimitField(provider.id)] = getSettings().maxOutputTokens;
      // reasoning_effort steers a reasoning model away from a deep chain on a trivial
      // prompt. It means nothing to a generator, so it isn't sent to one.
      if (!media && !omitReasoning(provider.id, model.id)) {
        payload.reasoning_effort = 'low';
      }

      try {
        const { deadline } = kindLimits(model.kind);
        const result = await request({
          url: `${baseUrl}/chat/completions`,
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          requestId,
          timeoutMs: deadline,
          ...routeTestTags(requestId),
        });

        // A cancelled hedge loser (raceAttempts skips those) or a transport failure.
        const lost = transportFailure(result, key.id);
        if (lost) return lost;

        // Usage some providers send on every answer (Token Harbor's allowance
        // headers) keeps the key's reading current without asking for it.
        observeUsage(provider.id, key.id, result.headers);

        if (result.status === 200) {
          const parsed = stream ? parseStreamedCompletion(result.body) : parseChatCompletion(result.body);
          const usage = parsed.usage || {};
          if (!parsed.content) return { ...buildEmptyResult(usage, result.elapsed), keyId: key.id };
          const pass = {
            keyId: key.id,
            status: 'pass',
            response: parsed.content,
            isEmpty: false,
            time: result.elapsed,
            tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
          };
          // A generator answering over chat still has to hand back a real asset.
          if (media) {
            const verified = await verifyAsset(extractMediaUrl(parsed.content), model.kind, {}, requestId);
            if (typeof verified === 'boolean') pass.assetVerified = verified;
          }
          return pass;
        }

        const failed = failFromResponse(result, key.id);
        const errMsg = failed.response;

        // "Unsupported parameter: max_tokens" and friends — switch the field and go
        // again rather than reporting a working model as broken.
        // A re-send after a rejected parameter is the same attempt, marked as one.
        const swapId = () => nextRequestId({ ...getRequestTags(requestId), paramSwap: true });
        if (result.status === 400 && /max_tokens|max_completion_tokens/i.test(errMsg)) {
          const swapped = swapTokenLimitField(provider.id);
          if (swapped) return attemptOnce(model, provider, stream, swapId());
        }
        if (result.status === 400 && payload.reasoning_effort && reasoningRejected(errMsg)) {
          disableReasoning(provider.id, model.id);
          return attemptOnce(model, provider, stream, swapId());
        }
        return failed;
      } catch (err) {
        return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0, cancelled: !!err.cancelled, networkError: !err.cancelled, keyId: key.id };
      }
    }
    return { attemptOnce, attemptChat, attemptImage, attemptVideo, attemptDecision, verifyAsset, assetResult };
  },
};
