// ============================================
// Model benchmark — quick, cheap, deterministic
// ============================================
// A fixed suite of 21 short tasks (reasoning & math, coding, instruction
// following; seven per category in easy, hard and expert tiers worth 1, 2 and
// 3 points) plus a latency probe and a throughput probe. Every task has a
// machine-checked answer, so two runs of the same model are scored by the same
// rule and two models are scored on the same questions. A full run is 23
// requests, each capped at a few hundred output tokens: under a minute and a
// fraction of a cent, which is what lets every model in the catalogue be
// benchmarked.
//
// Loaded after app.js, so it can use its helpers (settings, usableKeys,
// tokenLimitField, parseChatCompletion, parseStreamedCompletion).

(function () {
  'use strict';

  const SUITE_VERSION = 3;

  // ---- answer helpers ------------------------------------------------------

  // Models sometimes wrap a reply in a code fence or lead with their thinking.
  function cleanReply(text) {
    let t = String(text || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    t = t.replace(/```[a-z]*\n?/gi, '');
    return t.trim();
  }

  function lastLine(text) {
    const lines = cleanReply(text).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  }

  // "Answer with only the number": the last number in the last line is the
  // answer. A short reply that contains the number anywhere also passes, so a
  // model that writes "8 dollars" isn't punished for a unit.
  function gradeNumber(expected) {
    return (text) => {
      const line = lastLine(text);
      const nums = line.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
      if (nums && Number(nums[nums.length - 1]) === expected) return true;
      const whole = cleanReply(text).replace(/,/g, '');
      if (whole.length <= 40) {
        const all = whole.match(/-?\d+(?:\.\d+)?/g) || [];
        return all.some((n) => Number(n) === expected);
      }
      return false;
    };
  }

  // "Answer with only the name": the last line names the answer and none of the
  // alternatives (a reply listing every option is not an answer).
  function gradeWord(expected, alternatives) {
    const exp = expected.toLowerCase();
    const alts = alternatives.map((a) => a.toLowerCase()).filter((a) => a !== exp);
    return (text) => {
      const line = lastLine(text).toLowerCase();
      if (!line.includes(exp)) return false;
      return !alts.some((a) => line.includes(a));
    };
  }

  function gradeRegexSolution(shouldMatch, shouldNot) {
    return (text) => {
      let pat = lastLine(text).replace(/^`+|`+$/g, '').replace(/^["']|["']$/g, '').trim();
      // A delimited /…/ pattern is still a pattern.
      const m = pat.match(/^\/(.+)\/[a-z]*$/);
      if (m) pat = m[1];
      if (!pat || pat.length > 200) return false;
      let re;
      try {
        re = new RegExp(`^(?:${pat.replace(/^\^/, '').replace(/\$$/, '')})$`);
      } catch (_) {
        return false;
      }
      return shouldMatch.every((s) => re.test(s)) && shouldNot.every((s) => !re.test(s));
    };
  }

  function gradeJson(check) {
    return (text) => {
      const t = cleanReply(text);
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start < 0 || end <= start) return false;
      try {
        return check(JSON.parse(t.slice(start, end + 1)));
      } catch (_) {
        return false;
      }
    };
  }

  function gradeExact(expected) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return (text) => norm(cleanReply(text)) === norm(expected);
  }

  // Arabic replies: Arabic-Indic digits become ASCII, tashkeel is dropped,
  // alef/taa-marbuta variants are unified, and both comma shapes separate.
  function normalizeArabic(s) {
    return String(s || '')
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
      .replace(/[ً-ْـ]/g, '')
      .replace(/[آأإ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[،؛]/g, ',');
  }

  function gradeArabicNumber(expected) {
    const g = gradeNumber(expected);
    return (text) => g(normalizeArabic(text));
  }

  function gradeArabicSequence(expected) {
    const want = expected.map((w) => normalizeArabic(w).trim());
    return (text) => {
      // Whole reply, not the last line: a model may list one word per line.
      const got = normalizeArabic(cleanReply(text)).replace(/[.!؟?]+$/g, '').split(/[,\n]+|\s+و\s*(?=\S)/).map((w) => w.replace(/^و/, '').trim()).filter(Boolean);
      return got.length === want.length && got.every((w, i) => w === want[i]);
    };
  }

  function gradeWordCount(n) {
    return (text) => {
      const words = cleanReply(text).replace(/[^\p{L}\p{N}'’\s-]/gu, ' ').split(/\s+/).filter(Boolean);
      return words.length === n;
    };
  }

  // ---- the suite -----------------------------------------------------------
  // Each item: id, category, label (shown in the UI), prompt, grade(text)->bool.

  const TASKS = [
    // Reasoning & math
    {
      id: 'r1', category: 'reasoning', label: 'Unit pricing',
      prompt: 'A shop sells pens at 3 for $2. How much do 12 pens cost in dollars? Answer with only the number.',
      grade: gradeNumber(8),
    },
    {
      id: 'r2', category: 'reasoning', label: 'Calendar arithmetic',
      prompt: 'If today is Wednesday, what day of the week will it be in 100 days? Answer with only the day name.',
      grade: gradeWord('friday', ['monday', 'tuesday', 'wednesday', 'thursday', 'saturday', 'sunday']),
    },
    {
      id: 'r3', category: 'reasoning', label: 'Ordering puzzle',
      prompt: 'Alice is taller than Bob. Bob is taller than Carol. Dave is shorter than Carol. Who is the second tallest? Answer with only the name.',
      grade: gradeWord('bob', ['alice', 'carol', 'dave']),
    },
    // Reasoning & math — hard (worth double)
    {
      id: 'r4', category: 'reasoning', label: 'Counting with exclusion', hard: true,
      prompt: 'How many positive integers less than 1000 are divisible by 7 but not by 5? Answer with only the number.',
      grade: gradeNumber(114),
    },
    {
      id: 'r5', category: 'reasoning', label: 'Race ordering', hard: true,
      prompt: 'Five runners A, B, C, D and E finish a race. A finished before B but after C. D finished after B. E finished between C and A. Who finished last? Answer with only the letter.',
      grade: gradeWord('d', ['a', 'b', 'c', 'e']),
    },
    // Coding
    {
      id: 'c1', category: 'coding', label: 'Trace Python',
      prompt: 'What does this Python program print? Answer with only the output.\n\nx = [1, 2, 3, 4, 5]\nprint(sum(x[1:4]) * len(x))',
      grade: gradeNumber(45),
    },
    {
      id: 'c2', category: 'coding', label: 'Trace JavaScript',
      prompt: "What does this JavaScript log? Answer with only the output.\n\nconst s = 'benchmark';\nconsole.log(s.split('').filter(c => 'aeiou'.includes(c)).length + s.indexOf('m'));",
      grade: gradeNumber(7),
    },
    {
      id: 'c3', category: 'coding', label: 'Write a regex',
      prompt: 'Write one regular expression that matches a 4-digit year from 1900 to 2099 when tested against the whole string. Reply with only the pattern: no delimiters, no anchors, no explanation.',
      grade: gradeRegexSolution(['1900', '1999', '2000', '2099', '1957'], ['1899', '2100', '20000', '199', 'abcd', '2O00']),
    },
    // Coding — hard (worth double)
    {
      id: 'c4', category: 'coding', label: 'Recursion trace', hard: true,
      prompt: 'What does this Python program print? Answer with only the output.\n\ndef f(n):\n    return n if n < 2 else f(n - 1) + f(n - 2)\n\nprint(sum(f(i) for i in range(8)))',
      grade: gradeNumber(33),
    },
    {
      id: 'c5', category: 'coding', label: 'Closure semantics', hard: true,
      prompt: "What does this JavaScript log? Answer with only the output.\n\nvar fns = [];\nfor (var i = 0; i < 3; i++) fns.push(() => i * 10);\nconsole.log(fns.map(f => f()).join(','));",
      grade: gradeExact('30,30,30'),
    },
    // Instruction following
    {
      id: 'i1', category: 'instruction', label: 'Strict JSON',
      prompt: 'Return a JSON object with exactly two keys: "city" set to the string "Cairo" and "population_millions" set to the number 22. Output only the JSON, no markdown, no commentary.',
      grade: gradeJson((o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 2 && o.city === 'Cairo' && o.population_millions === 22),
    },
    {
      id: 'i2', category: 'instruction', label: 'Exact format',
      prompt: 'List the three primary colours of light (red, green, blue) in reverse alphabetical order, comma-separated, all lowercase, and output nothing else.',
      grade: gradeExact('red, green, blue'),
    },
    {
      id: 'i3', category: 'instruction', label: 'Exact length',
      prompt: 'Write exactly five words about the ocean. Output nothing else: no title, no punctuation-only lines, no explanation.',
      grade: gradeWordCount(5),
    },
    // Reasoning & math — expert (worth triple)
    {
      id: 'r6', category: 'reasoning', label: 'Clock angle', tier: 'expert',
      prompt: 'What is the smaller angle, in degrees, between the hour hand and the minute hand of an analogue clock at 3:40? Answer with only the number.',
      grade: gradeNumber(130),
    },
    {
      id: 'r7', category: 'reasoning', label: 'Maximise a product', tier: 'expert',
      prompt: 'Using each of the digits 2, 3, 5 and 7 exactly once, form two two-digit numbers whose product is as large as possible. What is that product? Answer with only the number.',
      grade: gradeNumber(3816),
    },
    // Coding — expert (worth triple)
    {
      id: 'c6', category: 'coding', label: 'Mutable default', tier: 'expert',
      prompt: 'What does this Python program print? Answer with only the output.\n\ndef f(x, acc=[]):\n    acc.append(x)\n    return len(acc)\n\nprint(f(1) + f(2) + f(3, []))',
      grade: gradeNumber(4),
    },
    {
      id: 'c7', category: 'coding', label: 'Default sort order', tier: 'expert',
      prompt: "What does this JavaScript log? Answer with only the output.\n\nconsole.log([1, 2, 10, 21].sort().join('-'));",
      grade: gradeExact('1-10-2-21'),
    },
    // Instruction following — expert (worth triple)
    {
      id: 'i6', category: 'instruction', label: 'Numbered reverse list', tier: 'expert',
      prompt: "List the twelve months of the year in reverse order, one per line, each line formatted as the month's number in the year, a colon, a space, then the month name (the first line is \"12: December\"). Output nothing else.",
      grade: (text) => {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const lines = cleanReply(text).split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length !== 12) return false;
        return lines.every((l, i) => l.replace(/\s+/g, ' ').toLowerCase() === `${12 - i}: ${months[11 - i]}`.toLowerCase());
      },
    },
    {
      id: 'i7', category: 'instruction', label: 'Caesar shift', tier: 'expert',
      prompt: "Encode the word benchmark by shifting every letter forward by 3 positions in the alphabet, wrapping z to a. Reply with only the encoded word in lowercase.",
      grade: gradeExact('ehqfkpdun'),
    },
    // Language (Arabic) — comprehension and instruction following in Arabic,
    // where models differ far more than they do in English.
    {
      id: 'l1', category: 'language', label: 'Arabic arithmetic', tier: 'easy',
      prompt: 'ما هو ناتج ضرب سبعة في ثمانية؟ أجب بالرقم فقط.',
      grade: gradeArabicNumber(56),
    },
    {
      id: 'l2', category: 'language', label: 'Arabic ordering', tier: 'hard',
      prompt: 'رتّب الكلمات التالية ترتيباً أبجدياً عربياً وافصل بينها بفاصلة، ولا تكتب أي شيء آخر: كتاب، باب، تفاحة، أرنب',
      grade: gradeArabicSequence(['أرنب', 'باب', 'تفاحة', 'كتاب']),
    },
    // Instruction following — hard (worth double)
    {
      id: 'i4', category: 'instruction', label: 'FizzBuzz to spec', hard: true,
      prompt: "Output the numbers 1 to 20 separated by commas, replacing multiples of 3 with fizz, multiples of 5 with buzz, and multiples of both with fizzbuzz. All lowercase, no spaces, no other text.",
      grade: gradeExact('1,2,fizz,4,buzz,fizz,7,8,fizz,buzz,11,fizz,13,14,fizzbuzz,16,17,fizz,19,buzz'),
    },
    {
      id: 'i5', category: 'instruction', label: 'Constrained sentence', hard: true,
      prompt: 'Write one sentence of exactly eight words in which every word begins with the letter S. Output only the sentence.',
      grade: (text) => {
        const words = cleanReply(text).replace(/[^\p{L}\p{N}'’\s-]/gu, ' ').split(/\s+/).filter(Boolean);
        return words.length === 8 && words.every((w) => /^s/i.test(w));
      },
    },
  ];

  // Every task gets a difficulty tier; the weight is what the task is worth.
  const TIER_WEIGHT = { easy: 1, hard: 2, expert: 3 };
  TASKS.forEach((t) => {
    if (!t.tier) t.tier = t.hard ? 'hard' : 'easy';
    t.hard = t.tier !== 'easy';
    t.weight = TIER_WEIGHT[t.tier];
  });
  // Reported (and queued) by category, easy to expert, so the run climbs the
  // difficulty ladder and the report reads the same way.
  {
    const cat = ['reasoning', 'coding', 'instruction', 'language'];
    const tier = ['easy', 'hard', 'expert'];
    TASKS.sort((a, b) => cat.indexOf(a.category) - cat.indexOf(b.category) || tier.indexOf(a.tier) - tier.indexOf(b.tier));
  }

  // Streamed probes. The latency probe wants the shortest possible answer, so
  // the time to its first content token is the model's floor. The throughput
  // probe wants ~100 tokens of trivially predictable text, so tokens per
  // second is measured on generation alone, after the first token.
  const LATENCY_PROBE = {
    id: 'lat', label: 'Latency probe',
    prompt: 'Reply with the single word OK.',
    maxTokens: 64,
  };
  const THROUGHPUT_PROBE = {
    id: 'tps', label: 'Throughput probe',
    prompt: 'Write the numbers from 1 to 80 in order, separated by single spaces, on one line. Output nothing else.',
    maxTokens: 400,
  };

  const CATEGORIES = {
    reasoning: { label: 'Reasoning & Math', short: 'Reason', weight: 0.32 },
    coding: { label: 'Coding', short: 'Code', weight: 0.32 },
    instruction: { label: 'Instruction following', short: 'Instruct', weight: 0.26 },
    language: { label: 'Arabic', short: 'Arabic', weight: 0.10 },
  };

  // Composite weights. Intelligence dominates: a fast wrong answer is still
  // wrong, and a slow gateway in front of a strong model is a gateway problem.
  const WEIGHTS = { quality: 0.70, speed: 0.20, reliability: 0.10 };
  const SPEED_WEIGHTS = { latency: 0.40, ttft: 0.35, tps: 0.25 };

  // Per category the points are 3 easy + 2×2 hard + 2×3 expert = 13, so a
  // model that clears only the easy tier scores 23 and one that also clears
  // the hard tier scores 54. S is for models that solve the expert tasks too.
  const TIERS = [
    { id: 'S', min: 85, label: 'Elite' },
    { id: 'A', min: 72, label: 'Strong' },
    { id: 'B', min: 58, label: 'Solid' },
    { id: 'C', min: 42, label: 'Basic' },
    { id: 'D', min: 0, label: 'Weak' },
  ];

  function tierOf(score) {
    if (score == null || Number.isNaN(score)) return null;
    return TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
  }

  // Log-linear map of a "lower is better" measurement onto 0–100.
  function scoreLowerBetter(value, best, worst) {
    if (value == null || !(value > 0)) return null;
    if (value <= best) return 100;
    if (value >= worst) return 0;
    const t = (Math.log(value) - Math.log(best)) / (Math.log(worst) - Math.log(best));
    return Math.round((1 - t) * 100);
  }

  function scoreHigherBetter(value, worst, best) {
    if (value == null || !(value > 0)) return null;
    if (value >= best) return 100;
    if (value <= worst) return 0;
    const t = (Math.log(value) - Math.log(worst)) / (Math.log(best) - Math.log(worst));
    return Math.round(t * 100);
  }

  function median(nums) {
    const a = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  // ---- scoring -------------------------------------------------------------
  // items:  [{ id, category, weight, ok, status, time, completionTokens }]
  // probes: { latency: { status, time, ttft }, throughput: { status, time, ttft, tokens } }
  //
  // Only tasks the model actually answered count towards intelligence. A
  // provider error, a timeout or an empty stream says nothing about whether
  // the model knows the answer — it is a reliability problem, and it is scored
  // there. A run with too few answered tasks is reported as incomplete rather
  // than as a low score.
  const MIN_ANSWERED_SHARE = 0.6;

  function score(items, probes) {
    const byCat = {};
    Object.keys(CATEGORIES).forEach((c) => { byCat[c] = { passed: 0, total: 0, answered: 0, points: 0, maxPoints: 0 }; });
    items.forEach((it) => {
      const b = byCat[it.category];
      if (!b) return;
      const w = it.weight || 1;
      b.total += 1;
      if (it.status !== 'ok') return;   // unscored, not wrong
      b.answered += 1;
      b.maxPoints += w;
      if (it.ok) { b.passed += 1; b.points += w; }
    });
    const categories = {};
    let quality = 0;
    let wsumQ = 0;
    Object.entries(CATEGORIES).forEach(([c, meta]) => {
      const b = byCat[c];
      const s = b.maxPoints ? Math.round((b.points / b.maxPoints) * 100) : null;
      categories[c] = { score: s, passed: b.passed, answered: b.answered, total: b.total, points: b.points, maxPoints: b.maxPoints };
      if (s != null) { quality += s * meta.weight; wsumQ += meta.weight; }
    });
    quality = wsumQ ? Math.round(quality / wsumQ) : null;

    const answered = items.filter((it) => it.status === 'ok');
    const latencyMs = median(answered.map((it) => it.time));
    const lat = probes.latency || {};
    const thr = probes.throughput || {};
    const ttftCandidates = [lat.ttft, thr.ttft].filter((v) => typeof v === 'number' && v > 0);
    const ttftMs = ttftCandidates.length ? Math.min(...ttftCandidates) : null;
    // Generation speed from the throughput probe alone: tokens after the first
    // token, over the time after the first token. Provider usage is not
    // trusted for this — several gateways report 0 or 1 completion tokens.
    let tps = null;
    if (thr.status === 'ok' && thr.tokens > 8 && thr.time > (thr.ttft || 0)) {
      const genMs = thr.time - (thr.ttft || 0);
      if (genMs > 50) tps = Math.round((thr.tokens / (genMs / 1000)) * 10) / 10;
    }

    const latencyScore = scoreLowerBetter(latencyMs, 1500, 20000);
    const ttftScore = scoreLowerBetter(ttftMs, 300, 8000);
    const tpsScore = scoreHigherBetter(tps, 10, 150);
    const parts = [
      [latencyScore, SPEED_WEIGHTS.latency],
      [ttftScore, SPEED_WEIGHTS.ttft],
      [tpsScore, SPEED_WEIGHTS.tps],
    ].filter(([s]) => s != null);
    const wsum = parts.reduce((n, [, w]) => n + w, 0);
    const speed = wsum ? Math.round(parts.reduce((n, [s, w]) => n + s * w, 0) / wsum) : null;

    const probeList = [lat, thr].filter((p) => p && p.status);
    const all = items.length + probeList.length;
    const okCount = answered.length + probeList.filter((p) => p.status === 'ok').length;
    const reliability = all ? Math.round((okCount / all) * 100) : 0;

    const incomplete = answered.length < Math.ceil(items.length * MIN_ANSWERED_SHARE);
    const composite = incomplete || quality == null
      ? null
      : Math.round(quality * WEIGHTS.quality + (speed ?? 0) * WEIGHTS.speed + reliability * WEIGHTS.reliability);
    return {
      composite,
      tier: composite == null ? null : tierOf(composite).id,
      incomplete,
      answered: answered.length,
      quality,
      speed,
      reliability,
      categories,
      latencyMs,
      ttftMs,
      tps,
      latencyScore,
      ttftScore,
      tpsScore,
    };
  }

  // ---- running -------------------------------------------------------------

  function providerBase(provider) {
    return String(provider.baseUrl || '').replace(/\/+$/, '');
  }

  function keysFor(provider, model) {
    const usable = usableKeys(provider);
    if (Array.isArray(model.keyIds) && model.keyIds.length) {
      const scoped = usable.filter((k) => model.keyIds.includes(k.id));
      if (scoped.length) return scoped;
    }
    return usable;
  }

  function retryAfterMs(result) {
    const h = result.headers || {};
    const ra = Number(h['retry-after']);
    if (ra > 0) return Math.min(ra * 1000, 15000);
    return 4000;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const BENCH_DEADLINE_MS = 45000;
  const LANES = 3;

  // One request. Returns { status:'ok'|'error'|'empty'|'timeout'|'ratelimit', text, time, ttft, completionTokens, error }
  async function ask(provider, model, key, prompt, { stream = false, maxTokens = 400, signal } = {}) {
    const payload = {
      model: model.id,
      messages: [{ role: 'user', content: prompt }],
      stream,
      temperature: 0,
    };
    payload[tokenLimitField(provider.id)] = maxTokens;
    if (typeof noReasoningEffort !== 'undefined' && !noReasoningEffort.has(reasoningKey(provider.id, model.id))) {
      payload.reasoning_effort = 'low';
    }
    if (stream) payload.stream_options = { include_usage: true };

    const requestId = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const onAbort = () => window.electronAPI.cancelApiRequest(requestId);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let result;
    try {
      result = await window.electronAPI.apiRequest({
        url: `${providerBase(provider)}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        requestId,
        // A trivia question that takes longer than this is a failed request as
        // far as the benchmark is concerned; the main test flow's deadline is
        // for generators. A hung request would otherwise stall a whole lane.
        timeoutMs: Math.min(Number(settings.deadlineChatMs) || BENCH_DEADLINE_MS, BENCH_DEADLINE_MS),
        logLevel: settings.logLevel,
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (result.cancelled) return { status: 'cancelled', time: result.elapsed };
    if (result.timedOut) return { status: 'timeout', time: result.elapsed, error: result.error };
    if (result.networkError) return { status: 'error', time: result.elapsed, error: result.error || 'Network error' };
    if (result.status === 429) return { status: 'ratelimit', time: result.elapsed, retryMs: retryAfterMs(result) };
    if (result.status !== 200) {
      let msg = `HTTP ${result.status}`;
      try {
        const j = JSON.parse(result.body);
        msg = j.error?.message || j.message || msg;
      } catch (_) {}
      return { status: 'error', time: result.elapsed, httpStatus: result.status, error: String(msg).slice(0, 200) };
    }
    let parsed;
    try {
      parsed = stream ? parseStreamedCompletion(result.body) : parseChatCompletion(result.body);
    } catch (err) {
      return { status: 'error', time: result.elapsed, error: 'Unreadable response' };
    }
    const usage = parsed.usage || {};
    const text = parsed.content || '';
    // Some gateways report 0 or 1 completion tokens whatever was generated,
    // so the count is sanity-checked against the text and estimated when it
    // is implausible (~3.5 characters per token for plain ASCII).
    const estimated = Math.ceil(text.length / 3.5);
    const reported = Number(usage.completion_tokens) || 0;
    return {
      status: text ? 'ok' : 'empty',
      text,
      time: result.elapsed,
      // First content token when the proxy let it through; otherwise the first
      // byte, which is what an older main process reports.
      ttft: stream ? (result.firstTokenMs || result.firstByteMs || null) : null,
      completionTokens: reported >= estimated / 2 ? reported : estimated,
      tokensEstimated: reported < estimated / 2,
      promptTokens: usage.prompt_tokens || 0,
    };
  }

  // Runs one prompt with rate-limit waits and retries on transient failures
  // (5xx, network, timeout, empty stream): two more attempts, spaced out, and
  // the next key when there is one, since a proxy hiccup rarely repeats.
  async function askWithRetry(provider, model, keys, prompt, opts, onNote) {
    let keyIx = 0;
    let waits = 0;
    let retries = 0;
    for (;;) {
      if (opts.signal && opts.signal.aborted) return { status: 'cancelled', time: 0 };
      const key = keys[keyIx % keys.length];
      const r = await ask(provider, model, key, prompt, opts);
      if (r.status === 'ratelimit' && waits < 3) {
        waits += 1;
        keyIx += 1; // another key may have headroom
        if (onNote) onNote(`Rate limited — waiting ${Math.round(r.retryMs / 1000)}s`);
        await sleep(r.retryMs);
        continue;
      }
      const transient = (r.status === 'error' && (!r.httpStatus || r.httpStatus >= 500 || r.httpStatus === 408))
        || r.status === 'timeout' || r.status === 'empty';
      if (transient && retries < 2) {
        retries += 1;
        keyIx += 1;
        if (onNote) onNote(`${r.error || r.status} — retrying (${retries}/2)`);
        await sleep(1500 * retries);
        continue;
      }
      // A 400 for max_tokens / reasoning_effort is learned the same way the
      // main test flow learns it, then retried once.
      if (r.status === 'error' && r.httpStatus === 400 && retries < 2) {
        const msg = (r.error || '').toLowerCase();
        if (/max_tokens|max_completion_tokens|unsupported parameter/.test(msg) && typeof swapTokenLimitField === 'function') {
          if (swapTokenLimitField(provider.id)) { retries += 1; continue; }
        }
        if (/thinking|reasoning[_ ]effort|reasoning\.effort/.test(msg) && typeof noReasoningEffort !== 'undefined') {
          noReasoningEffort.add(reasoningKey(provider.id, model.id));
          retries += 1;
          continue;
        }
      }
      return { ...r, keyId: key.id };
    }
  }

  // Runs the full suite for one model. onProgress({ done, total, note }) is
  // called as items finish. The two probes go first and alone, so nothing
  // else is in flight while they are timed; the graded tasks then run three
  // at a time (rate limits are waited out per request).
  async function run(provider, model, { onProgress, signal } = {}) {
    const keys = keysFor(provider, model);
    if (!keys.length) throw new Error('No active key for this provider');
    const total = TASKS.length + 2;
    let done = 0;
    const tick = (note) => { if (onProgress) onProgress({ done, total, note }); };
    tick('Starting');

    const probes = {};
    {
      const r = await askWithRetry(provider, model, keys, LATENCY_PROBE.prompt, { stream: true, maxTokens: LATENCY_PROBE.maxTokens, signal }, tick);
      // A reasoning model may spend the small budget thinking and send no text;
      // the stream still started, and that is what this probe times.
      const started = r.status === 'ok' || r.status === 'empty';
      probes.latency = { status: started ? 'ok' : r.status, time: r.time, ttft: r.ttft || (started ? r.time : null), error: r.error };
      done += 1;
      tick(`Latency probe: ${started ? `first token ${probes.latency.ttft}ms` : r.status}`);
    }
    if (signal && signal.aborted) throw new Error('Cancelled');
    {
      const r = await askWithRetry(provider, model, keys, THROUGHPUT_PROBE.prompt, { stream: true, maxTokens: THROUGHPUT_PROBE.maxTokens, signal }, tick);
      // Tokens are counted from the text itself (numbers separated by spaces
      // tokenise at roughly one token each), never from provider usage.
      const tokens = r.status === 'ok' ? Math.max(cleanReply(r.text).split(/\s+/).filter(Boolean).length, Math.ceil((r.text || '').length / 3.5)) : 0;
      probes.throughput = { status: r.status, time: r.time, ttft: r.ttft || null, tokens, error: r.error };
      done += 1;
      tick(`Throughput probe: ${r.status === 'ok' ? `${tokens} tokens in ${r.time}ms` : r.status}`);
    }
    if (signal && signal.aborted) throw new Error('Cancelled');

    const items = [];
    const queue = [...TASKS];
    const lane = async () => {
      while (queue.length) {
        if (signal && signal.aborted) return;
        const task = queue.shift();
        const r = await askWithRetry(provider, model, keys, task.prompt, { maxTokens: 400, signal }, tick);
        const ok = r.status === 'ok' && !!task.grade(r.text);
        items.push({
          id: task.id, category: task.category, label: task.label, tier: task.tier, weight: task.weight, hard: !!task.hard,
          ok, status: r.status, time: r.time, completionTokens: r.completionTokens || 0,
          reply: r.status === 'ok' ? cleanReply(r.text).slice(0, 160) : (r.error || r.status),
          keyId: r.keyId,
        });
        done += 1;
        tick(`${task.label}: ${ok ? 'pass' : r.status === 'ok' ? 'wrong' : r.status}`);
      }
    };
    await Promise.all(Array.from({ length: LANES }, () => lane()));
    if (signal && signal.aborted) throw new Error('Cancelled');

    // Task order in the report follows the suite, not completion order.
    const order = new Map(TASKS.map((t, i) => [t.id, i]));
    items.sort((a, b) => order.get(a.id) - order.get(b.id));
    const scores = score(items, probes);
    return {
      suite: SUITE_VERSION,
      at: Date.now(),
      provider: provider.id,
      model: model.id,
      items,
      probes,
      ...scores,
    };
  }

  // ---- capability probes ---------------------------------------------------
  // Three one-off requests that tell a router what a model can be trusted
  // with: native tool calling, strict JSON output, and a long prompt with a
  // needle in it. Cached per model and re-run only on demand or when stale,
  // so they cost the catalogue three requests per model, once.
  const CAPS_VERSION = 1;
  const LONG_CONTEXT_WORDS = 4200; // ~5.5k tokens: long enough to matter, cheap enough to run on every model

  async function rawChat(provider, model, key, payload, { signal, timeoutMs } = {}) {
    const requestId = `caps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const onAbort = () => window.electronAPI.cancelApiRequest(requestId);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await window.electronAPI.apiRequest({
        url: `${providerBase(provider)}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        requestId,
        timeoutMs: timeoutMs || BENCH_DEADLINE_MS,
        logLevel: settings.logLevel,
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function basePayload(provider, model, content, maxTokens) {
    const p = { model: model.id, messages: [{ role: 'user', content }], stream: false, temperature: 0 };
    p[tokenLimitField(provider.id)] = maxTokens;
    if (typeof noReasoningEffort !== 'undefined' && !noReasoningEffort.has(reasoningKey(provider.id, model.id))) p.reasoning_effort = 'low';
    return p;
  }

  function errorMessage(result) {
    try {
      const j = JSON.parse(result.body);
      return String(j.error?.message || j.message || `HTTP ${result.status}`);
    } catch (_) {
      return `HTTP ${result.status}`;
    }
  }

  // A probe answers a capability question only when the provider actually
  // processed the request. A rate limit, an outage or a parameter the
  // benchmark hasn't learned yet is "unknown", never "unsupported" — an
  // unknown is re-probed, a false is cached for two weeks and can cost the
  // model a profile. Transient failures get two more tries first.
  async function probeRequest(provider, model, key, payload, opts = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await rawChat(provider, model, key, payload, opts);
      if (r.cancelled) return { r, verdict: 'unknown', note: 'cancelled' };
      if (r.networkError || r.timedOut || r.status === 429 || r.status === 408 || r.status >= 500) {
        if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
        return { r, verdict: 'unknown', note: r.error || `HTTP ${r.status}` };
      }
      if (r.status === 400) {
        const msg = errorMessage(r).toLowerCase();
        if (/max_tokens|max_completion_tokens|unsupported parameter/.test(msg) && typeof swapTokenLimitField === 'function' && swapTokenLimitField(provider.id)) {
          payload[tokenLimitField(provider.id)] = payload.max_tokens ?? payload.max_completion_tokens;
          delete payload[tokenLimitField(provider.id) === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'];
          continue;
        }
        if (/thinking|reasoning[_ ]effort|reasoning\.effort/.test(msg) && typeof noReasoningEffort !== 'undefined') {
          noReasoningEffort.add(reasoningKey(provider.id, model.id));
          delete payload.reasoning_effort;
          continue;
        }
        if (/temperature/.test(msg) && 'temperature' in payload) { delete payload.temperature; continue; }
        return { r, verdict: 'no', note: errorMessage(r).slice(0, 120) };
      }
      if (r.status !== 200) return { r, verdict: 'no', note: errorMessage(r).slice(0, 120) };
      return { r, verdict: 'ok' };
    }
    return { r: null, verdict: 'unknown', note: 'gave up' };
  }

  // supported: true | false | null (could not tell: transport failure)
  async function probeTools(provider, model, key, signal) {
    const payload = basePayload(provider, model, 'What is the weather in Cairo right now? You must call the get_weather tool to find out.', 200);
    payload.tools = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    payload.tool_choice = 'auto';
    const { r, verdict, note } = await probeRequest(provider, model, key, payload, { signal });
    if (verdict === 'unknown') return { supported: null, time: r ? r.elapsed : null, note };
    if (verdict === 'no') return { supported: false, time: r.elapsed, note };
    try {
      const msg = JSON.parse(r.body).choices?.[0]?.message || {};
      const calls = msg.tool_calls || (msg.function_call ? [{ function: msg.function_call }] : []);
      const called = calls.some((c) => (c.function?.name || c.name) === 'get_weather');
      return { supported: called, time: r.elapsed, note: called ? 'called get_weather' : 'answered in text instead of calling the tool' };
    } catch (_) {
      return { supported: false, time: r.elapsed, note: 'unreadable response' };
    }
  }

  async function probeJson(provider, model, key, signal) {
    const payload = basePayload(provider, model, 'Return a JSON object with exactly one key, "ok", set to the boolean true.', 60);
    payload.response_format = { type: 'json_object' };
    const { r, verdict, note } = await probeRequest(provider, model, key, payload, { signal });
    if (verdict === 'unknown') return { supported: null, time: r ? r.elapsed : null, note };
    if (verdict === 'no') return { supported: false, time: r.elapsed, note };
    try {
      const text = parseChatCompletion(r.body).content || '';
      const t = cleanReply(text);
      const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      const ok = obj && obj.ok === true;
      return { supported: !!ok, time: r.elapsed, note: ok ? 'strict JSON honoured' : `replied: ${t.slice(0, 60)}` };
    } catch (_) {
      return { supported: false, time: r.elapsed, note: 'reply was not JSON' };
    }
  }

  function longPrompt() {
    const filler = 'The harbour records list arrivals by tide, cargo and captain, and the clerk copies each line twice before the ledger is sealed. ';
    const words = filler.trim().split(' ');
    const out = [];
    let n = 0;
    const needleAt = Math.floor(LONG_CONTEXT_WORDS * 0.42);
    while (n < LONG_CONTEXT_WORDS) {
      for (const w of words) { out.push(w); n += 1; if (n === needleAt) out.push('The secret code is 7391.'); }
    }
    return `Read the following notes carefully.\n\n${out.join(' ')}\n\nWhat is the secret code mentioned in the notes? Answer with only the number.`;
  }

  async function probeLongContext(provider, model, key, signal, contextWindow) {
    if (contextWindow && contextWindow < 8000) return { supported: false, time: null, note: `context window ${contextWindow} is below the probe size`, skipped: true };
    const payload = basePayload(provider, model, longPrompt(), 60);
    const { r, verdict, note } = await probeRequest(provider, model, key, payload, { signal, timeoutMs: 90000 });
    if (verdict === 'unknown') return { supported: null, time: r ? r.elapsed : null, note };
    if (verdict === 'no') return { supported: false, time: r.elapsed, note };
    try {
      const text = parseChatCompletion(r.body).content || '';
      const ok = gradeNumber(7391)(text);
      return { supported: ok, time: r.elapsed, note: ok ? `found the needle in ${Math.round(r.elapsed / 100) / 10}s` : `replied: ${cleanReply(text).slice(0, 60)}` };
    } catch (_) {
      return { supported: false, time: r.elapsed, note: 'unreadable response' };
    }
  }

  async function probeCapabilities(provider, model, { signal, onProgress } = {}) {
    const keys = keysFor(provider, model);
    if (!keys.length) throw new Error('No active key for this provider');
    const key = keys[0];
    const tick = (note) => { if (onProgress) onProgress({ note }); };
    tick('Probing tool calling');
    const tools = await probeTools(provider, model, key, signal);
    if (signal && signal.aborted) throw new Error('Cancelled');
    tick('Probing JSON mode');
    const json = await probeJson(provider, model, key, signal);
    if (signal && signal.aborted) throw new Error('Cancelled');
    tick('Probing long context');
    const longContext = await probeLongContext(provider, model, key, signal, model.contextWindow);
    if (signal && signal.aborted) throw new Error('Cancelled');
    return { version: CAPS_VERSION, at: Date.now(), tools, json, longContext, longLatencyMs: longContext.time || null };
  }

  // ---- global reference (Artificial Analysis) ------------------------------

  const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|max|minimal|non-reasoning|reasoning|thinking|instruct)$/;

  function normalizeId(id) {
    let s = String(id || '').toLowerCase().trim();
    if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
    s = s.replace(/:latest$/, '').replace(/:free$/, '').replace(/:.*$/, '');
    s = s.replace(/[._\s:]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    // Trailing dates ("-20250514", "-0905") say when, not what.
    s = s.replace(/-(?:20\d{6}|\d{4})$/, '');
    return s;
  }

  function baseOf(slug) {
    let s = slug;
    for (let i = 0; i < 2; i++) s = s.replace(EFFORT_SUFFIX, '');
    return s;
  }

  function tokensOf(s) {
    return new Set(s.split('-').filter(Boolean));
  }

  function jaccard(a, b) {
    let inter = 0;
    a.forEach((t) => { if (b.has(t)) inter += 1; });
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
  }

  // Which leaderboard entry a provider's model id refers to. Returns
  // { entry, confidence:'exact'|'family'|'approx' } or null.
  function matchGlobal(modelId, entries, hints = {}) {
    if (!entries || !entries.length) return null;
    const id = normalizeId(modelId);
    if (!id) return null;
    const exact = entries.find((e) => normalizeId(e.slug) === id || normalizeId(e.name) === id);
    if (exact) return { entry: exact, confidence: 'exact' };

    // The same model appears once per reasoning effort. A bare id means the
    // default: the unsuffixed slug, else medium, else the best-scoring variant.
    const idBase = baseOf(id);
    const family = entries.filter((e) => baseOf(normalizeId(e.slug)) === idBase);
    if (family.length) {
      const wantsThinking = hints.hasReasoning || /think|reason/.test(id);
      const pick = family.find((e) => normalizeId(e.slug) === idBase && !wantsThinking)
        || family.find((e) => /-medium$/.test(normalizeId(e.slug)))
        || family.find((e) => wantsThinking ? !/non-reasoning$/.test(normalizeId(e.slug)) : /non-reasoning$/.test(normalizeId(e.slug)))
        || family.slice().sort((a, b) => (b.index || 0) - (a.index || 0))[0];
      return { entry: pick, confidence: 'family' };
    }

    // Last resort: token overlap, only when it is strong.
    const idTokens = tokensOf(idBase);
    if (idTokens.size < 2) return null;
    let best = null;
    let bestScore = 0;
    entries.forEach((e) => {
      const s = jaccard(idTokens, tokensOf(baseOf(normalizeId(e.slug))));
      if (s > bestScore) { bestScore = s; best = e; }
    });
    if (best && bestScore >= 0.75) return { entry: best, confidence: 'approx' };
    return null;
  }

  // Where a global Intelligence Index would land in our tiers. The bands are
  // set so that the leaderboard's top quarter maps to S/A and its bottom
  // quarter to D — the same shape as our composite, so the two can be compared.
  function expectedTierFromIndex(index) {
    if (index == null) return null;
    if (index >= 45) return 'S';
    if (index >= 32) return 'A';
    if (index >= 20) return 'B';
    if (index >= 10) return 'C';
    return 'D';
  }

  const TIER_ORDER = ['D', 'C', 'B', 'A', 'S'];

  function compareTiers(ours, expected) {
    if (!ours || !expected) return null;
    const d = TIER_ORDER.indexOf(ours) - TIER_ORDER.indexOf(expected);
    if (d === 0) return { verdict: 'match', delta: 0, text: 'Matches the global tier' };
    if (Math.abs(d) === 1) return { verdict: 'close', delta: d, text: d > 0 ? 'One tier above global' : 'One tier below global' };
    return { verdict: 'diverge', delta: d, text: d > 0 ? 'Well above its global tier' : 'Well below its global tier' };
  }

  // Spearman rank correlation between our composite and the global index across
  // every benchmarked model that has a global match. This is the honest answer
  // to "is our benchmark right": above 0.7 the two rankings agree.
  function rankCorrelation(pairs) {
    const n = pairs.length;
    if (n < 3) return null;
    const rank = (vals) => {
      const sorted = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(n);
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && sorted[j + 1][0] === sorted[i][0]) j += 1;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) r[sorted[k][1]] = avg;
        i = j + 1;
      }
      return r;
    };
    const ra = rank(pairs.map((p) => p[0]));
    const rb = rank(pairs.map((p) => p[1]));
    const ma = ra.reduce((s, v) => s + v, 0) / n;
    const mb = rb.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
      num += (ra[i] - ma) * (rb[i] - mb);
      da += (ra[i] - ma) ** 2;
      db += (rb[i] - mb) ** 2;
    }
    if (!da || !db) return null;
    return Math.round((num / Math.sqrt(da * db)) * 100) / 100;
  }

  function agreementLabel(rho) {
    if (rho == null) return { label: 'Not enough data', tone: 'muted' };
    if (rho >= 0.7) return { label: 'Strong agreement', tone: 'good' };
    if (rho >= 0.4) return { label: 'Moderate agreement', tone: 'warn' };
    if (rho >= 0) return { label: 'Weak agreement', tone: 'bad' };
    return { label: 'Disagrees', tone: 'bad' };
  }

  window.BENCHMARK = {
    SUITE_VERSION,
    TASKS,
    CATEGORIES,
    TIERS,
    TIER_WEIGHT,
    WEIGHTS,
    tierOf,
    score,
    run,
    probeCapabilities,
    CAPS_VERSION,
    baseOf,
    normalizeId,
    matchGlobal,
    expectedTierFromIndex,
    compareTiers,
    rankCorrelation,
    agreementLabel,
    // exposed for tests
    _graders: { gradeNumber, gradeWord, gradeRegexSolution, gradeJson, gradeExact, gradeWordCount, cleanReply },
  };
})();
