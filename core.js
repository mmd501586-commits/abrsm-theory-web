/** Deterministic, local-only learning rules. This module has no browser I/O. */
export const REVIEW_DAYS = Object.freeze([1, 3, 7, 14, 30, 60]);
export const RETRY_DELAY_MS = 7 * 60 * 1000;
const clone = value => structuredClone(value);
const unique = values => [...new Set(values)];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const sorted = values => [...(values || [])].sort();
const STUDY_LANGUAGES = Object.freeze(['Italian', 'French', 'German']);
const STUDY_CATEGORIES = Object.freeze(['all', 'terms', 'signs', 'instruments']);

/** A saved learning scope is explicit; an empty or invalid choice never widens it. */
export function normalizeScope(scope = {}) {
  if (!isObject(scope)) throw new Error('学习范围无效。');
  const category = scope.category ?? 'all';
  const levelMode = scope.levelMode ?? 'all';
  const level = scope.level ?? 1;
  const languages = scope.languages ?? [...STUDY_LANGUAGES];
  if (!STUDY_CATEGORIES.includes(category) || !['all', 'exact', 'through'].includes(levelMode) ||
      !Number.isInteger(level) || level < 1 || level > 5 || !Array.isArray(languages) ||
      languages.length === 0 || languages.length > STUDY_LANGUAGES.length ||
      new Set(languages).size !== languages.length || languages.some(language => !STUDY_LANGUAGES.includes(language))) {
    throw new Error('学习范围无效，请选择教材级别和至少一种术语语言。');
  }
  return { category, levelMode, level, languages: STUDY_LANGUAGES.filter(language => languages.includes(language)) };
}

/** Add V1.1 defaults without rebuilding, rescoring, or dropping V1.0 evidence. */
export function normalizeStudyState(state) {
  const next = clone(state);
  if (next.settings.studyMode === undefined) next.settings.studyMode = 'auto';
  if (!['auto', 'scoped'].includes(next.settings.studyMode)) throw new Error('学习安排方式无效。');
  next.settings.studyScope = normalizeScope(next.settings.studyScope);
  if (next.quizzes === undefined) next.quizzes = [];
  if (next.levelMilestones === undefined) next.levelMilestones = {};
  return next;
}

export function getStudyScope(state) {
  return normalizeScope(state.settings.studyMode === 'scoped' ? state.settings.studyScope : undefined);
}

export function cardMatchesScope(card, scope = {}) {
  const selected = normalizeScope(scope);
  if (!card || (selected.category !== 'all' && card.category !== selected.category)) return false;
  if (selected.levelMode !== 'all' && (!Number.isInteger(card.level) ||
      (selected.levelMode === 'exact' ? card.level !== selected.level : card.level > selected.level))) return false;
  // Language is a term property, not the Chinese presentation language of a question.
  return card.category !== 'terms' || selected.languages.length === STUDY_LANGUAGES.length || selected.languages.includes(card.language);
}

export function questionMatchesScope(data, question, scope = {}) {
  const selected = normalizeScope(scope);
  if (!question || (selected.category !== 'all' && question.category !== selected.category)) return false;
  const byId = new Map(data.cards.map(card => [card.id, card]));
  const targets = (question.knowledgeIds || []).map(id => byId.get(id));
  if (!targets.length || targets.some(card => !cardMatchesScope(card, selected))) return false;
  const languages = unique([
    ...(question.termLanguages || []), ...(question.scopeLanguages || []),
    ...targets.filter(card => card.category === 'terms').map(card => card.language).filter(Boolean),
  ]);
  if (languages.some(language => !selected.languages.includes(language))) return false;
  // Foreign words visibly offered as distractors may use earlier knowledge but
  // cannot silently require a later grade. Primary targets still follow exact/through.
  if (selected.levelMode !== 'all') {
    const levels = [...(question.scopeLevels || []), question.level].filter(Number.isInteger);
    if (levels.some(level => level > selected.level)) return false;
  }
  return true;
}

export function createState(version = '') {
  return {
    schemaVersion: 1, datasetVersion: version,
    settings: { dailyNew: 5, examMinutes: 10, studyMode: 'auto', studyScope: normalizeScope() },
    learned: {}, skills: {}, history: [], exams: [], quizzes: [], levelMilestones: {}, lastSeen: {}, activeSession: null,
  };
}

export function dayKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysLater(now, days) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

// Review intervals name local calendar dates, so an evening answer is due the
// next morning, not only after the exact clock time of the previous answer.
function reviewDate(now, days) {
  const date = new Date(daysLater(now, days));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** A relation/attribute/direction is evidence, not all knowledge about its entities. */
export function skillKey(question) {
  return JSON.stringify([
    question.category, question.direction || '', question.assessmentDimension || '',
    sorted(question.knowledgeIds), sorted(question.relationshipIds),
    canonical(question.factTargets || []),
  ]);
}

function eligibleQuestions(data) {
  return data.questions.filter(question => question.role !== 'hold');
}

function validExamQuestions(questions) {
  return questions.length === 10 && new Set(questions.map(question => question?.id)).size === 10 &&
    questions.every(question => question?.section6Candidate && question.role !== 'hold') &&
    questions.slice(0, 3).every(question => ['terms', 'signs'].includes(question.category) && question.direction !== 'performed_notation_to_ornament') &&
    questions.slice(3, 5).every(question => question.category === 'signs' && question.direction === 'performed_notation_to_ornament') &&
    questions.slice(5).every(question => question.category === 'instruments' &&
      (question.questionType === 'true_false' || question.options.length === 2));
}

function unresolved(skill) {
  return Boolean(skill?.lastWrongAt && skill.lastWrongAt >= (skill.lastIndependentAt || 0));
}

function ranked(questions, state, random = Math.random) {
  return questions.map(question => ({ question, last: state.lastSeen[question.id] || 0, tie: random() }))
    .sort((a, b) => a.last - b.last || a.tie - b.tie).map(entry => entry.question);
}

function shuffled(values, random = Math.random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

export function shuffleOptions(question, random = Math.random) {
  return shuffled(clone(question.options), random);
}

export function selectPractice(data, state, options = {}, now = Date.now(), random = Math.random) {
  const { category = 'all', direction = 'all', count = 10, mode = 'practice' } = options;
  const scope = options.scope === undefined ? getStudyScope(state) : normalizeScope(options.scope);
  let pool = eligibleQuestions(data).filter(question =>
    questionMatchesScope(data, question, scope) &&
    (category === 'all' || question.category === category) &&
    (direction === 'all' || question.category !== 'terms' || question.direction === direction));
  if (mode === 'mistakes') pool = pool.filter(question => unresolved(state.skills[skillKey(question)]));
  if (mode === 'due') pool = pool.filter(question => state.skills[skillKey(question)]?.dueAt <= now);
  return ranked(pool, state, random).slice(0, Math.max(0, Math.min(100, Number(count) || 0))).map(question => question.id);
}

/** A scoped quiz has its actual number of audited questions, never a fabricated exam shape. */
export function buildScopeQuiz(data, state, options = {}, now = Date.now(), random = Math.random) {
  return selectPractice(data, state, { scope: options.scope ?? getStudyScope(state), count: options.count ?? 10 }, now, random);
}

/** Three term/sign questions, two performed ornaments, five instrument/voice judgments. */
export function buildExam(data, state, now = Date.now(), random = Math.random) {
  const candidates = data.questions.filter(question => question.section6Candidate && question.role !== 'hold');
  const firstPool = ranked(candidates.filter(question => ['terms', 'signs'].includes(question.category) &&
    question.direction !== 'performed_notation_to_ornament'), state, random);
  const ornaments = ranked(candidates.filter(question => question.category === 'signs' &&
    question.direction === 'performed_notation_to_ornament'), state, random).slice(0, 2);
  const instrumentPool = ranked(candidates.filter(question => question.category === 'instruments' &&
    (question.questionType === 'true_false' || question.options.length === 2)), state, random);
  const first = [];
  const instruments = [];
  const take = (destination, pool) => {
    const next = pool.find(question => !destination.some(old => old.id === question.id));
    if (next) destination.push(next);
  };
  take(first, firstPool.filter(question => question.category === 'terms'));
  while (first.length < 3 && first.length < firstPool.length) take(first, firstPool);
  take(instruments, instrumentPool.filter(question => question.knowledgeIds.some(id => id.startsWith('voice-'))));
  for (const dimension of ['family', 'reed', 'definite_pitch', 'relative_range']) {
    take(instruments, instrumentPool.filter(question => question.assessmentDimension === dimension &&
      !question.knowledgeIds.some(id => id.startsWith('voice-'))));
  }
  while (instruments.length < 5 && instruments.length < instrumentPool.length) take(instruments, instrumentPool);
  if (first.length !== 3 || ornaments.length !== 2 || instruments.length !== 5) {
    throw new Error('当前审核题库不足以组成 3＋2＋5 的完整模拟练习。');
  }
  return [...shuffled(first, random), ...ornaments, ...shuffled(instruments, random)].map(question => question.id);
}

function deterministicTie(seed) {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return (value >>> 0) / 4294967296;
}

export function buildDailyPlan(data, state, now = Date.now(), options = {}) {
  const today = dayKey(now);
  const mode = options.mode ?? (options.scope === undefined ? (state.settings.studyMode || 'auto') : 'scoped');
  if (!['auto', 'scoped'].includes(mode)) throw new Error('学习安排方式无效。');
  const scope = normalizeScope(options.scope ?? (mode === 'scoped' ? state.settings.studyScope : undefined));
  const allQuestions = eligibleQuestions(data);
  const questions = allQuestions.filter(question => questionMatchesScope(data, question, scope));
  const allKeys = new Set(allQuestions.map(skillKey));
  const bySkill = new Map();
  for (const question of questions) {
    const key = skillKey(question);
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push(question);
  }
  const chosenSkills = new Set();
  const items = [];
  const pickForSkill = key => [...(bySkill.get(key) || [])].sort((a, b) =>
    (state.lastSeen[a.id] || 0) - (state.lastSeen[b.id] || 0) ||
    deterministicTie(today + a.id) - deterministicTie(today + b.id))[0];
  const scheduled = Object.entries(state.skills).filter(([key]) => bySkill.has(key));
  const add = (key, kind) => {
    if (chosenSkills.has(key)) return;
    const question = pickForSkill(key);
    if (question) {
      items.push({ questionId: question.id, kind });
      chosenSkills.add(key);
    }
  };
  const due = scheduled.filter(([, skill]) => skill.dueAt <= now)
    .sort((a, b) => Number(unresolved(b[1])) - Number(unresolved(a[1])) || a[1].dueAt - b[1].dueAt);
  // A busy day first clears actual due work; it does not pull future reviews forward.
  for (const [key, skill] of due.slice(0, 15)) add(key, unresolved(skill) ? 'mistake' : 'due');
  for (const [key, skill] of scheduled.filter(([, skill]) => skill.retryAt > 0 && skill.retryAt <= now)
    .sort((a, b) => a[1].retryAt - b[1].retryAt)) {
    if (items.length < 15) add(key, 'retry');
  }
  const alreadyIntroduced = new Set(state.history.filter(entry => entry.day === today)
    .flatMap(entry => entry.newKnowledgeIds || []));
  // Scope changes must not turn previously practised knowledge into "new" again.
  const seenKnowledge = new Set(Object.values(state.skills).flatMap(skill => skill.knowledgeIds));
  const newQuota = Math.max(0, Math.min(5, state.settings.dailyNew) - alreadyIntroduced.size);
  const newBudget = options.reviewOnly ? 0 : Math.min(newQuota, Math.max(0, 12 - items.length));
  const cardIndex = new Map(data.cards.map(card => [card.id, card]));
  const cardOrder = new Map(data.cards.map((card, index) => [card.id, index]));
  const questionOrder = new Map(data.questions.map((question, index) => [question.id, index]));
  const candidates = questions.filter(question => question.knowledgeIds.length === 1 &&
    !seenKnowledge.has(question.knowledgeIds[0]) && !state.skills[skillKey(question)])
    .sort((a, b) => {
      const levelA = cardIndex.get(a.knowledgeIds[0])?.level || 1;
      const levelB = cardIndex.get(b.knowledgeIds[0])?.level || 1;
      const preference = question => question.direction === 'term_to_meaning' ? 0 :
        question.direction === 'meaning_to_term' ? 2 : 1;
      return levelA - levelB || preference(a) - preference(b) ||
        cardOrder.get(a.knowledgeIds[0]) - cardOrder.get(b.knowledgeIds[0]) || questionOrder.get(a.id) - questionOrder.get(b.id);
    });
  const newItems = [];
  const newKnowledge = new Set();
  // Rotate across the three subjects, within cumulative grade knowledge.
  for (let turn = 0; newItems.length < newBudget && turn < 15; turn += 1) {
    const category = ['terms', 'signs', 'instruments'][turn % 3];
    const next = candidates.find(question => question.category === category &&
      !newKnowledge.has(question.knowledgeIds[0]));
    if (next) {
      newItems.push({ questionId: next.id, kind: 'new' });
      newKnowledge.add(next.knowledgeIds[0]);
    }
  }
  items.push(...newItems);
  // New directions/attributes of a known card must eventually be introduced;
  // otherwise daily-only use could never meet the report's multi-skill criteria.
  const extensionUsed = state.history.filter(entry => entry.day === today && entry.newSkill && entry.newKnowledgeIds.length === 0).length;
  const extensionBudget = options.reviewOnly ? 0 : Math.min(Math.max(0, 3 - extensionUsed), Math.max(0, 15 - items.length));
  const extensions = questions.filter(question => !state.skills[skillKey(question)] &&
    question.knowledgeIds.length > 0 && question.knowledgeIds.every(id => seenKnowledge.has(id)))
    .sort((a, b) => deterministicTie(today + a.id) - deterministicTie(today + b.id));
  let extensionCount = 0;
  for (const question of extensions) {
    if (extensionCount >= extensionBudget) break;
    const key = skillKey(question);
    if (chosenSkills.has(key)) continue;
    items.push({ questionId: question.id, kind: 'extend' });
    chosenSkills.add(key);
    extensionCount += 1;
  }
  return {
    items, newCount: newItems.length, extensionCount, scope, mode,
    dueCount: items.filter(item => ['due', 'mistake'].includes(item.kind)).length,
    retryCount: items.filter(item => item.kind === 'retry').length,
    remainingDueCount: Math.max(0, due.length - items.filter(item => ['due', 'mistake'].includes(item.kind)).length),
    outsideDueCount: Object.entries(state.skills).filter(([key, skill]) => allKeys.has(key) && !bySkill.has(key) &&
      (skill.dueAt <= now || (skill.retryAt > 0 && skill.retryAt <= now))).length,
  };
}

export function markLearned(state, cardId, now = Date.now()) {
  if (!cardId || !timestamp(now)) throw new Error('学习记录参数无效。');
  const next = clone(state);
  if (!next.learned[cardId]) next.learned[cardId] = { at: now };
  return next;
}

export function recordAnswer(state, question, optionId, options = {}) {
  const { now = Date.now(), mode = 'practice', sessionId = `${mode}@${now}` } = options;
  if (!timestamp(now) || typeof sessionId !== 'string' || !sessionId) throw new Error('答题记录参数无效。');
  if (!question.options.some(option => option.id === optionId) && !(['exam', 'quiz'].includes(mode) && optionId === null)) {
    throw new Error('答案选项无效，未写入学习记录。');
  }
  const eventId = JSON.stringify([sessionId, question.id]);
  if (state.history.some(entry => entry.id === eventId)) return clone(state);
  const next = clone(state);
  const key = skillKey(question);
  const previous = next.skills[key];
  const skill = previous || {
    key, knowledgeIds: [...question.knowledgeIds], questionIds: [], stage: 0,
    dueAt: 0, retryAt: 0, lastAnswerAt: 0, lastIndependentAt: 0,
    firstIndependentAt: 0, lastWrongAt: 0, wrongCount: 0, attempts: 0, correctCount: 0,
  };
  const correct = optionId === question.answerId;
  const independent = correct && mode !== 'retry' &&
    (!previous || (previous.dueAt <= now && dayKey(previous.lastIndependentAt || 0) !== dayKey(now)));
  const knownBefore = new Set(Object.values(state.skills).flatMap(item => item.knowledgeIds));
  const newKnowledgeIds = question.knowledgeIds.filter(id => !knownBefore.has(id));
  skill.questionIds = unique([...skill.questionIds, question.id]);
  skill.attempts += 1;
  skill.correctCount += Number(correct);
  skill.lastAnswerAt = now;
  if (!correct) {
    skill.stage = 0;
    skill.dueAt = reviewDate(now, 1);
    skill.retryAt = now + RETRY_DELAY_MS;
    skill.lastWrongAt = now;
    skill.wrongCount += 1;
  } else if (independent) {
    skill.stage = Math.min(REVIEW_DAYS.length, skill.stage + 1);
    skill.dueAt = reviewDate(now, REVIEW_DAYS[skill.stage - 1]);
    skill.retryAt = 0;
    skill.lastIndependentAt = now;
    if (!skill.firstIndependentAt) skill.firstIndependentAt = now;
  } else if (skill.retryAt > 0 && skill.retryAt <= now) {
    skill.retryAt = 0; // Passing a short retest never postpones tomorrow's real review.
  }
  next.skills[key] = skill;
  next.lastSeen[question.id] = now;
  next.history.push({
    id: eventId, questionId: question.id, skillKey: key, knowledgeIds: [...question.knowledgeIds],
    optionId, correct, at: now, day: dayKey(now), mode, sessionId,
    independent, stageAfter: skill.stage, newKnowledgeIds, newSkill: !previous,
  });
  return next;
}

export function finishExam(state, questions, answers, options = {}) {
  const { now = Date.now(), startedAt = now, sessionId } = options;
  if (!sessionId || !timestamp(now) || !timestamp(startedAt) || startedAt > now ||
      questions.length !== 10 || new Set(questions.map(question => question.id)).size !== 10) {
    throw new Error('模拟练习会话无效，未覆盖学习记录。');
  }
  const existing = state.exams.find(exam => exam.sessionId === sessionId);
  if (existing) return { state: clone(state), result: clone(existing) };
  if (!validExamQuestions(questions)) {
    throw new Error('模拟练习题目不符合已审核的 3＋2＋5 结构。');
  }
  let next = clone(state);
  const results = questions.map(question => {
    const optionId = answers[question.id] ?? null;
    next = recordAnswer(next, question, optionId, { now, mode: 'exam', sessionId });
    return { questionId: question.id, optionId, correct: optionId === question.answerId, answerId: question.answerId };
  });
  const section = (start, end) => ({ score: results.slice(start, end).filter(item => item.correct).length, total: end - start });
  const result = {
    id: sessionId, sessionId, startedAt, finishedAt: now,
    score: results.filter(item => item.correct).length, total: 10,
    sections: { terms: section(0, 3), signs: section(3, 5), instruments: section(5, 10) },
    answers: results, wrongIds: results.filter(item => !item.correct).map(item => item.questionId),
    durationMs: now - startedAt,
  };
  next.exams.push(result);
  return { state: next, result: clone(result) };
}

export function finishScopeQuiz(state, questions, answers, options = {}) {
  const { now = Date.now(), startedAt = now, sessionId } = options;
  const scope = normalizeScope(options.scope ?? getStudyScope(state));
  if (typeof sessionId !== 'string' || !sessionId || !timestamp(now) || !timestamp(startedAt) || startedAt > now ||
      !Array.isArray(questions) || questions.length < 1 || questions.length > 100 ||
      new Set(questions.map(question => question?.id)).size !== questions.length ||
      questions.some(question => !question || question.role === 'hold' || !STUDY_CATEGORIES.slice(1).includes(question.category))) {
    throw new Error('按范围测验会话无效，未覆盖学习记录。');
  }
  const existing = (state.quizzes || []).find(quiz => quiz.sessionId === sessionId);
  if (existing) return { state: clone(state), result: clone(existing) };
  if (state.exams.some(exam => exam.sessionId === sessionId) || state.history.some(entry => entry.sessionId === sessionId)) {
    throw new Error('按范围测验会话标识已被使用，未覆盖学习记录。');
  }
  let next = normalizeStudyState(state);
  const results = questions.map(question => {
    const optionId = answers[question.id] ?? null;
    next = recordAnswer(next, question, optionId, { now, mode: 'quiz', sessionId });
    return { questionId: question.id, optionId, correct: optionId === question.answerId, answerId: question.answerId };
  });
  const sections = Object.fromEntries(STUDY_CATEGORIES.slice(1).map(category => {
    const entries = results.filter((_, index) => questions[index].category === category);
    return [category, { score: entries.filter(item => item.correct).length, total: entries.length }];
  }));
  const result = {
    id: sessionId, sessionId, mode: 'quiz', scope, startedAt, finishedAt: now,
    score: results.filter(item => item.correct).length, total: questions.length, sections,
    answers: results, wrongIds: results.filter(item => !item.correct).map(item => item.questionId), durationMs: now - startedAt,
  };
  next.quizzes.push(result);
  return { state: next, result: clone(result) };
}

/** Full-grade milestones concern both translation directions of every term, in every language. */
export function summarizeTermLevels(data, state, now = Date.now()) {
  const directions = ['term_to_meaning', 'meaning_to_term'];
  const required = new Map(data.cards.filter(card => card.category === 'terms').map(card =>
    [card.id, Object.fromEntries(directions.map(direction => [direction, new Set()]))]));
  for (const question of eligibleQuestions(data)) {
    if (question.category !== 'terms' || !directions.includes(question.direction) || question.knowledgeIds.length !== 1) continue;
    required.get(question.knowledgeIds[0])?.[question.direction].add(skillKey(question));
  }
  return [1, 2, 3, 4, 5].map(level => {
    const cards = data.cards.filter(card => card.category === 'terms' && card.level === level);
    const statuses = cards.map(card => {
      const groups = directions.map(direction => [...required.get(card.id)[direction]]);
      const keys = unique(groups.flat());
      const skills = keys.map(key => state.skills[key]);
      const supported = groups.every(group => group.length > 0);
      return {
        supported,
        mastered: supported && skills.every(skill => skill && skill.stage >= 3 && !unresolved(skill)),
        needsReview: skills.some(unresolved),
        due: skills.some(skill => skill && (skill.dueAt <= now || (skill.retryAt > 0 && skill.retryAt <= now))),
      };
    });
    const mastered = statuses.filter(status => status.mastered).length;
    return {
      level, total: cards.length, mastered, complete: cards.length > 0 && mastered === cards.length,
      achievedAt: state.levelMilestones?.[level]?.achievedAt ?? null,
      needsReview: statuses.filter(status => status.needsReview).length,
      nextLevel: level < 5 ? level + 1 : null,
      unsupported: statuses.filter(status => !status.supported).length,
      dueCount: statuses.filter(status => status.due).length,
      criterion: 'term-bidirectional-stage3-v1',
    };
  });
}

export function updateLevelMilestones(data, state, now = Date.now()) {
  if (!timestamp(now)) throw new Error('掌握记录时间无效。');
  const next = normalizeStudyState(state);
  for (const level of summarizeTermLevels(data, next, now)) {
    if (level.complete && !next.levelMilestones[level.level]) {
      next.levelMilestones[level.level] = { achievedAt: now, criterionVersion: 1 };
    }
  }
  // Neither recognition nor changing scope touches a skill's dueAt or removes it.
  return next;
}

export function summarize(data, state, now = Date.now()) {
  const required = new Map(data.cards.map(card => [card.id, new Set()]));
  const currentKeys = new Set();
  for (const question of eligibleQuestions(data)) {
    const key = skillKey(question);
    currentKeys.add(key);
    for (const id of question.knowledgeIds) required.get(id)?.add(key);
  }
  const empty = () => ({ total: 0, learned: 0, basic: 0, longTerm: 0, due: 0, mistakes: 0 });
  const total = empty();
  const categories = { terms: empty(), signs: empty(), instruments: empty() };
  const levels = Object.fromEntries([1, 2, 3, 4, 5].map(level => [level, empty()]));
  const cardStatus = {};
  for (const card of data.cards) {
    const keys = [...required.get(card.id)];
    const skills = keys.map(key => state.skills[key]);
    const flags = {
      total: true,
      learned: Boolean(state.learned[card.id] || skills.some(Boolean)),
      basic: keys.length > 0 && skills.every(skill => skill && skill.stage >= 3 && !unresolved(skill)),
      longTerm: keys.length > 0 && skills.every(skill => skill && skill.stage >= 5 && !unresolved(skill) &&
        now >= daysLater(skill.firstIndependentAt, 30)),
      due: skills.some(skill => skill && (skill.dueAt <= now || (skill.retryAt > 0 && skill.retryAt <= now))),
      mistakes: skills.some(unresolved),
    };
    cardStatus[card.id] = { ...flags, checkedSkills: skills.filter(Boolean).length, requiredSkills: keys.length };
    const destinations = [total, categories[card.category]];
    if (card.category === 'terms' && levels[card.level]) destinations.push(levels[card.level]);
    for (const destination of destinations) {
      if (destination) for (const key of Object.keys(destination)) destination[key] += Number(flags[key]);
    }
  }
  const daily = Array.from({ length: 14 }, (_, index) => {
    const day = dayKey(daysLater(now, index - 13));
    const events = state.history.filter(entry => entry.day === day);
    return { day, answers: events.length, correct: events.filter(entry => entry.correct).length };
  });
  const today = daily.at(-1);
  return {
    ...total, categories, levels, daily, cardStatus,
    todayAnswers: today.answers, todayCorrect: today.correct,
    accuracy: state.history.length ? Math.round(100 * state.history.filter(entry => entry.correct).length / state.history.length) : 0,
    recentExams: clone(state.exams.slice(-10).reverse()),
    skillsCount: Object.keys(state.skills).filter(key => currentKeys.has(key)).length,
    note: '掌握统计仅覆盖已收录的考查方向、属性与关系；一次答对不代表该知识所有语境都已掌握。',
  };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`无法导入：${message}`);
}

function rejectUnsafeKeys(value, depth = 0) {
  requireValue(depth < 40, '文件结构过深。');
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      requireValue(!['__proto__', 'constructor', 'prototype'].includes(key), '文件包含不安全的字段。');
      rejectUnsafeKeys(value[key], depth + 1);
    }
  }
}

export function validateImport(payload, data) {
  let input = payload;
  if (typeof input === 'string') {
    requireValue(input.length <= 15000000, '文件过大。');
    try { input = JSON.parse(input); } catch { throw new Error('无法导入：文件不是有效 JSON。'); }
  }
  rejectUnsafeKeys(input);
  if (isObject(input) && 'format' in input) {
    requireValue(input.format === 'abrsm-theory-progress' && input.version === 1, '不是本应用支持的备份格式。');
    input = input.state;
  }
  requireValue(isObject(input) && input.schemaVersion === 1 && typeof input.datasetVersion === 'string', '不支持的记录版本。');
  requireValue(isObject(input.settings) && Number.isInteger(input.settings.dailyNew) && input.settings.dailyNew >= 0 && input.settings.dailyNew <= 5 &&
    Number.isFinite(input.settings.examMinutes) && input.settings.examMinutes >= 0 && input.settings.examMinutes <= 120, '学习设置无效。');
  requireValue(input.settings.studyMode === undefined || ['auto', 'scoped'].includes(input.settings.studyMode), '学习安排方式无效。');
  if (input.settings.studyScope !== undefined) normalizeScope(input.settings.studyScope);
  for (const key of ['learned', 'skills', 'lastSeen']) requireValue(isObject(input[key]), `${key} 记录无效。`);
  for (const key of ['history', 'exams']) requireValue(Array.isArray(input[key]) && input[key].length <= 100000, `${key} 记录无效或过大。`);
  requireValue(input.quizzes === undefined || (Array.isArray(input.quizzes) && input.quizzes.length <= 100000), '按范围测验记录无效或过大。');
  requireValue(input.levelMilestones === undefined || isObject(input.levelMilestones), '级别达标记录无效。');
  for (const [level, milestone] of Object.entries(input.levelMilestones || {})) {
    requireValue(['1', '2', '3', '4', '5'].includes(level) && isObject(milestone) && timestamp(milestone.achievedAt) &&
      milestone.criterionVersion === 1, '级别达标记录无效。');
  }
  const cards = new Set(data.cards.map(card => card.id));
  const questions = new Map(data.questions.map(question => [question.id, question]));
  const knownSkills = new Map(data.questions.map(question => [skillKey(question), question]));
  for (const [id, item] of Object.entries(input.learned)) requireValue(cards.has(id) && isObject(item) && timestamp(item.at), '已学知识不存在或时间无效。');
  for (const [id, at] of Object.entries(input.lastSeen)) requireValue(questions.has(id) && timestamp(at), '最近答题记录无效。');
  for (const [key, skill] of Object.entries(input.skills)) {
    const question = knownSkills.get(key);
    requireValue(question && isObject(skill) && skill.key === key, '复习项目不属于当前题库。');
    requireValue(JSON.stringify(sorted(skill.knowledgeIds)) === JSON.stringify(sorted(question.knowledgeIds)), '复习项目的知识映射不一致。');
    requireValue(Array.isArray(skill.questionIds) && skill.questionIds.length > 0 && skill.questionIds.every(id => questions.has(id) && skillKey(questions.get(id)) === key), '复习项目的题目映射无效。');
    requireValue(Number.isInteger(skill.stage) && skill.stage >= 0 && skill.stage <= 6, '复习阶段无效。');
    for (const field of ['dueAt', 'retryAt', 'lastAnswerAt', 'lastIndependentAt', 'firstIndependentAt', 'lastWrongAt']) requireValue(timestamp(skill[field]), '复习日期无效。');
    for (const field of ['wrongCount', 'attempts', 'correctCount']) requireValue(Number.isInteger(skill[field]) && skill[field] >= 0, '答题计数无效。');
    requireValue(skill.correctCount <= skill.attempts && skill.wrongCount <= skill.attempts, '答题计数不一致。');
  }
  const events = new Set();
  const eventById = new Map();
  for (const entry of input.history) {
    requireValue(isObject(entry), '答题历史项无效。');
    const question = questions.get(entry.questionId);
    requireValue(question && typeof entry.sessionId === 'string' && entry.sessionId.length > 0 && entry.sessionId.length < 300, '答题历史引用无效。');
    requireValue(entry.id === JSON.stringify([entry.sessionId, question.id]) && !events.has(entry.id), '答题历史包含重复或无效事件。');
    events.add(entry.id);
    eventById.set(entry.id, entry);
    requireValue(entry.skillKey === skillKey(question) && timestamp(entry.at) && typeof entry.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.day), '答题历史日期或考点无效。');
    requireValue(question.options.some(option => option.id === entry.optionId) || (['exam', 'quiz'].includes(entry.mode) && entry.optionId === null), '历史答案选项无效。');
    requireValue(entry.correct === (entry.optionId === question.answerId) && typeof entry.independent === 'boolean', '历史判分不一致。');
    requireValue(JSON.stringify(sorted(entry.knowledgeIds)) === JSON.stringify(sorted(question.knowledgeIds)), '历史知识映射不一致。');
    requireValue(Number.isInteger(entry.stageAfter) && entry.stageAfter >= 0 && entry.stageAfter <= 6 &&
      Array.isArray(entry.newKnowledgeIds) && entry.newKnowledgeIds.every(id => question.knowledgeIds.includes(id)), '历史阶段无效。');
    requireValue(entry.newSkill === undefined || typeof entry.newSkill === 'boolean', '历史考点标志无效。');
  }
  const examIds = new Set();
  for (const exam of input.exams) {
    requireValue(isObject(exam) && typeof exam.sessionId === 'string' && !examIds.has(exam.sessionId) && exam.id === exam.sessionId, '模拟历史重复或无效。');
    examIds.add(exam.sessionId);
    requireValue(timestamp(exam.startedAt) && timestamp(exam.finishedAt) && exam.finishedAt >= exam.startedAt &&
      exam.durationMs === exam.finishedAt - exam.startedAt && exam.total === 10 && Array.isArray(exam.answers) && exam.answers.length === 10, '模拟历史结构无效。');
    requireValue(new Set(exam.answers.map(answer => answer.questionId)).size === 10, '模拟历史含重复题。');
    requireValue(validExamQuestions(exam.answers.map(answer => questions.get(answer.questionId))), '模拟历史不符合 3＋2＋5 结构。');
    for (const item of exam.answers) {
      const question = questions.get(item.questionId);
      requireValue(question?.section6Candidate && item.answerId === question.answerId && item.correct === (item.optionId === question.answerId), '模拟历史判分无效。');
      requireValue(question.options.some(option => option.id === item.optionId) || item.optionId === null, '模拟历史选项无效。');
    }
    requireValue(exam.score === exam.answers.filter(answer => answer.correct).length &&
      Array.isArray(exam.wrongIds) && JSON.stringify(exam.wrongIds) === JSON.stringify(exam.answers.filter(answer => !answer.correct).map(answer => answer.questionId)), '模拟得分与答案不一致。');
    for (const [name, start, end] of [['terms', 0, 3], ['signs', 3, 5], ['instruments', 5, 10]]) {
      requireValue(exam.sections?.[name]?.total === end - start && exam.sections[name].score === exam.answers.slice(start, end).filter(answer => answer.correct).length, '模拟分项成绩无效。');
    }
  }
  const quizIds = new Set();
  for (const quiz of input.quizzes || []) {
    requireValue(isObject(quiz) && typeof quiz.sessionId === 'string' && quiz.sessionId.length > 0 && quiz.sessionId.length < 300 &&
      !quizIds.has(quiz.sessionId) && !examIds.has(quiz.sessionId) && quiz.id === quiz.sessionId && quiz.mode === 'quiz', '按范围测验历史重复或无效。');
    quizIds.add(quiz.sessionId);
    requireValue(isObject(quiz.scope), '按范围测验缺少学习范围。');
    const scope = normalizeScope(quiz.scope);
    requireValue(timestamp(quiz.startedAt) && timestamp(quiz.finishedAt) && quiz.finishedAt >= quiz.startedAt &&
      quiz.durationMs === quiz.finishedAt - quiz.startedAt && Number.isInteger(quiz.total) && quiz.total >= 1 && quiz.total <= 100 &&
      Array.isArray(quiz.answers) && quiz.answers.length === quiz.total, '按范围测验历史结构无效。');
    requireValue(new Set(quiz.answers.map(answer => answer?.questionId)).size === quiz.total, '按范围测验历史含重复题。');
    for (const item of quiz.answers) {
      requireValue(isObject(item), '按范围测验答案记录无效。');
      const question = questions.get(item.questionId);
      requireValue(question && question.role !== 'hold' && questionMatchesScope(data, question, scope), '按范围测验包含范围外题目。');
      requireValue(item.answerId === question.answerId && item.correct === (item.optionId === question.answerId) &&
        (question.options.some(option => option.id === item.optionId) || item.optionId === null), '按范围测验历史判分无效。');
      const event = eventById.get(JSON.stringify([quiz.sessionId, question.id]));
      requireValue(event?.mode === 'quiz' && event.optionId === item.optionId && event.correct === item.correct,
        '按范围测验与作答记录不一致。');
    }
    requireValue(quiz.score === quiz.answers.filter(answer => answer.correct).length && Array.isArray(quiz.wrongIds) &&
      JSON.stringify(quiz.wrongIds) === JSON.stringify(quiz.answers.filter(answer => !answer.correct).map(answer => answer.questionId)), '按范围测验得分与答案不一致。');
    for (const category of STUDY_CATEGORIES.slice(1)) {
      const section = quiz.answers.filter(answer => questions.get(answer.questionId).category === category);
      requireValue(quiz.sections?.[category]?.total === section.length &&
        quiz.sections[category].score === section.filter(answer => answer.correct).length, '按范围测验分项成绩无效。');
    }
  }
  if (input.activeSession !== null) {
    const session = input.activeSession;
    requireValue(isObject(session) && typeof session.id === 'string' && ['daily', 'practice', 'exam', 'quiz'].includes(session.mode), '未完成会话无效。');
    requireValue(Array.isArray(session.questionIds) && session.questionIds.length > 0 && session.questionIds.length <= 100 &&
      new Set(session.questionIds).size === session.questionIds.length && session.questionIds.every(id => questions.has(id)), '未完成会话的题目无效。');
    if (session.mode === 'exam') requireValue(validExamQuestions(session.questionIds.map(id => questions.get(id))), '未完成模拟不符合 3＋2＋5 结构。');
    if (session.scope !== undefined) normalizeScope(session.scope);
    if (session.mode === 'quiz') {
      requireValue(isObject(session.scope), '未完成按范围测验缺少学习范围。');
      requireValue(session.questionIds.every(id => questions.get(id).role !== 'hold' && questionMatchesScope(data, questions.get(id), session.scope)),
        '未完成按范围测验包含范围外题目。');
      requireValue(session.feedback == null, '按范围测验提交前不能显示逐题反馈。');
    }
    requireValue(Number.isInteger(session.index) && session.index >= 0 && session.index <= session.questionIds.length &&
      timestamp(session.startedAt) && (session.deadline == null || (timestamp(session.deadline) && session.deadline >= session.startedAt)), '未完成会话时间无效。');
    requireValue(session.index < session.questionIds.length || session.completed === true, '会话位置已越过最后一题但未标记完成。');
    requireValue(isObject(session.answers) && isObject(session.optionOrders), '未完成会话的答案无效。');
    requireValue(Object.keys(session.optionOrders).length === session.questionIds.length, '会话选项顺序不完整。');
    for (const [id, answer] of Object.entries(session.answers)) requireValue(session.questionIds.includes(id) && questions.get(id).options.some(option => option.id === answer), '会话答案不属于当前题目。');
    for (const [id, order] of Object.entries(session.optionOrders)) requireValue(session.questionIds.includes(id) && Array.isArray(order) &&
      JSON.stringify(sorted(order)) === JSON.stringify(sorted(questions.get(id).options.map(option => option.id))), '会话选项顺序无效。');
    for (const field of ['studied', 'flagged']) {
      if (session[field] !== undefined) requireValue(isObject(session[field]) && Object.entries(session[field]).every(([id, value]) =>
        session.questionIds.includes(id) && typeof value === 'boolean'), '会话学习或标记状态无效。');
    }
    if (session.kinds !== undefined) requireValue(isObject(session.kinds) && Object.entries(session.kinds).every(([id, value]) =>
      session.questionIds.includes(id) && ['new', 'due', 'mistake', 'retry', 'review', 'extend', 'practice'].includes(value)), '会话任务类型无效。');
    if (session.completed !== undefined) requireValue(typeof session.completed === 'boolean', '会话完成标志无效。');
    if (session.feedback != null) requireValue(isObject(session.feedback) && session.questionIds.includes(session.feedback.questionId) &&
      typeof session.feedback.correct === 'boolean' && Object.prototype.hasOwnProperty.call(session.answers, session.feedback.questionId) &&
      session.feedback.correct === (session.answers[session.feedback.questionId] === questions.get(session.feedback.questionId).answerId), '会话反馈无效。');
  }
  const result = normalizeStudyState(input);
  result.datasetVersion = data.version;
  return result;
}

export function exportProgress(state) {
  return { format: 'abrsm-theory-progress', version: 1, exportedAt: new Date().toISOString(), state: clone(state) };
}
