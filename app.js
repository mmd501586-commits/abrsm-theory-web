import { DATA } from './data.js';
import { AUDIO_RECORDINGS, AUDIO_SAMPLES } from './audio-samples.js';
import {
  createState, dayKey, skillKey, buildDailyPlan, selectPractice, buildExam,
  shuffleOptions, recordAnswer, markLearned, summarize, finishExam,
  validateImport, exportProgress, normalizeScope, getStudyScope, normalizeStudyState,
  cardMatchesScope, questionMatchesScope, buildScopeQuiz, finishScopeQuiz,
  summarizeTermLevels, updateLevelMilestones,
} from './core.js';
import { loadState, saveState, storageStatus, requestPersistence, inspectStoredProgress } from './storage.js';
import './pwa.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const CAT = { terms: '音乐术语', signs: '符号与装饰音', instruments: '乐器与人声' };
const LANG = { Italian: '意大利语', French: '法语', German: '德语' };
const LANGUAGE_CODES = { Italian: 'it', French: 'fr', German: 'de' };
const questions = new Map(DATA.questions.map((item) => [item.id, item]));
const cards = new Map(DATA.cards.map((item) => [item.id, item]));
const audioRecordings = (Array.isArray(AUDIO_RECORDINGS) ? AUDIO_RECORDINGS : []).filter((recording) => cards.get(recording.cardId)?.category === 'terms');
const recordingsByCard = new Map(audioRecordings.map((recording) => [recording.cardId, recording]));
const audioSamples = (Array.isArray(AUDIO_SAMPLES) ? AUDIO_SAMPLES : []).filter((sample) => recordingsByCard.has(sample.cardId));
const main = $('#main');
const dialog = $('#detail-dialog');
const icons = {
  home: '<path d="m3 10 9-7 9 7v10H3V10Zm6 10v-7h6v7"/>',
  learn: '<path d="M12 6v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"/>',
  practice: '<path d="m13 3-9 11h7l-1 7 10-12h-7l1-6Z"/>',
  exam: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M8 10h8M8 14h5M8 18h3"/>',
  report: '<path d="M4 3v18h17M8 17v-5M13 17V8M18 17V4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4V9Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const empty = (title, text, action = '') => `<div class="empty"><span class="eyebrow">ONE SMALL STEP</span><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const prettyTime = (at) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const todayLabel = () => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const button = (action, text, kind = 'primary-button', attrs = '') => `<button type="button" class="${kind}" data-action="${action}" ${attrs}>${text}</button>`;
let state;
let loadSnapshot = null;
let saveFailureStatus = null;
let inspectedSources = [];
let busy = false;
let route = 'home';
let search = '';
let category = 'all';
let level = 'all';
let language = 'all';
let visibleCards = 24;
let practiceCategory = 'all';
let practiceDirection = 'all';
let practiceCount = 10;
let practiceMode = 'practice';
let practiceScope = null;
let quizScope = null;
let quizCount = 10;
let quizMinutes = null;
let currentDialogCard = null;
let revealed = new Set();
let deferredInstall = null;
let pwaStatus = window.__PWA_STATUS || { ready: false, message: '离线资源正在准备' };
let toastTimer;
let lastResult = null;
let timerSubmitting = false;
let speechVoices = [];
let voiceStatus = 'loading';
let voiceLoadTimer;
let activeUtterance = null;
let activeAudio = null;
let activeAudioCard = null;
let audioLoading = false;
let playbackToken = 0;
const speechErrors = new Map();

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}

function uiStorageStatus() {
  const status = storageStatus();
  return saveFailureStatus ? { ...status, ...saveFailureStatus, mode: 'memory', durable: false } : status;
}

function syncStorageBanner() {
  const status = uiStorageStatus();
  const banner = $('#storage-banner');
  banner.hidden = Boolean(status.durable);
  banner.innerHTML = status.durable ? '' : `<span>${esc(status.message || '当前浏览器无法保存记录。本次可继续练习，离开前请导出记录。')}</span>${button('storage-inspect', '检查本机记录', 'ghost-button', 'data-testid="storage-inspect"')}`;
}

async function persist(options = {}) {
  let result;
  try {
    state = updateLevelMilestones(DATA, state);
    result = await saveState(state, options);
    saveFailureStatus = result?.durable ? null : { reason: result?.reason || 'save-failed', message: result?.message || '当前更改只在本页暂存，尚未写入本机。下次打开可能仍是旧记录；离开前请在家长设置导出备份。' };
  } catch {
    saveFailureStatus = { reason: 'save-failed', message: '当前更改只在本页暂存，尚未写入本机。下次打开可能仍是旧记录；离开前请在家长设置导出备份。' };
  }
  syncStorageBanner();
  return result?.durable ? result : uiStorageStatus();
}

function navigate(next) {
  const valid = ['home', 'learn', 'practice', 'exam', 'quiz', 'report', 'session', 'result', 'audio'];
  stopPlayback();
  next = valid.includes(next) ? next : 'home';
  if (location.hash === `#${next}`) { route = next; render(); }
  else location.hash = next;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderNavigation() {
  let selected = route === 'audio' ? 'home' : route === 'quiz' ? 'exam' : route;
  if (['session', 'result'].includes(route)) selected = isAssessment(state.activeSession) ? 'exam' : 'practice';
  $('#navigation').innerHTML = [['home', '今天'], ['learn', '知识'], ['practice', '练习'], ['exam', '测验'], ['report', '记录']].map(([id, title]) => `<a href="#${id}" class="nav-button ${selected === id ? 'active' : ''}" data-testid="nav-${id}" ${selected === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${title}</span></a>`).join('');
}

function render() {
  if (!state) return;
  renderNavigation();
  syncStorageBanner();
  if (route === 'session' && !state.activeSession) route = 'home';
  if (route === 'session' && state.activeSession?.completed) route = 'result';
  const renderers = { home: renderHome, learn: renderLearn, practice: renderPractice, exam: renderExam, quiz: renderQuiz, report: renderReport, session: renderSession, result: renderResult, audio: renderAudio };
  main.innerHTML = `<div class="page">${(renderers[route] || renderHome)()}</div>`;
  updateTimer();
}

function isAssessment(session) { return session?.mode === 'exam' || session?.mode === 'quiz'; }

function sessionName(session) {
  return session?.mode === 'quiz' ? '按范围测验' : session?.mode === 'exam' ? '五级第六部分模拟' : session?.mode === 'daily' ? '本组学习任务' : '专项练习';
}

function scopeLabel(value) {
  const scope = normalizeScope(value);
  const grade = scope.levelMode === 'all' ? '全部级别' : scope.levelMode === 'exact' ? `仅第 ${scope.level} 级教材内容` : `第 1–${scope.level} 级累计内容`;
  const languages = scope.languages.length === 3 ? '全部术语语言' : scope.languages.map((name) => LANG[name]).join('、');
  return `${CAT[scope.category] || '全部类别'} · ${grade}${['all', 'terms'].includes(scope.category) ? ` · ${languages}` : ''}`;
}

function scopeEditor(prefix, value, { includeCategory = true } = {}) {
  const scope = normalizeScope(value);
  return `<div class="scope-editor" data-scope-editor="${prefix}">${includeCategory ? `<div class="field"><label for="${prefix}-category">学习类别</label><select id="${prefix}-category">${[['all', '全部类别'], ...Object.entries(CAT)].map(([id, title]) => `<option value="${id}" ${scope.category === id ? 'selected' : ''}>${title}</option>`).join('')}</select></div>` : ''}<div class="scope-grade-fields"><div class="field"><label for="${prefix}-level-mode">教材范围</label><select id="${prefix}-level-mode"><option value="all" ${scope.levelMode === 'all' ? 'selected' : ''}>全部级别</option><option value="exact" ${scope.levelMode === 'exact' ? 'selected' : ''}>仅这一级的内容</option><option value="through" ${scope.levelMode === 'through' ? 'selected' : ''}>从一级累计到这一级</option></select></div><div class="field"><label for="${prefix}-level">教材级别</label><select id="${prefix}-level" ${scope.levelMode === 'all' ? 'disabled' : ''}>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${scope.level === n ? 'selected' : ''}>第 ${n} 级</option>`).join('')}</select></div></div><fieldset class="scope-languages"><legend>术语语言，可多选</legend>${Object.entries(LANG).map(([id, title]) => `<label class="check-label" for="${prefix}-language-${id}"><input type="checkbox" id="${prefix}-language-${id}" data-scope-language="${prefix}" value="${id}" ${scope.languages.includes(id) ? 'checked' : ''}><span>${title}</span></label>`).join('')}<p class="small muted">只限制音乐术语，不会排除符号、乐器等没有术语语言的内容。</p></fieldset></div>`;
}

function readScope(prefix, fallbackCategory = 'all') {
  const languages = [...document.querySelectorAll(`input[data-scope-language="${prefix}"]:checked`)].map((input) => input.value);
  if (!languages.length) throw new Error('请至少选择一种术语语言。');
  return normalizeScope({ category: $(`#${prefix}-category`)?.value || fallbackCategory,
    levelMode: $(`#${prefix}-level-mode`).value, level: Number($(`#${prefix}-level`).value), languages });
}

function availableQuestions(scope, { direction = 'all', mistakesOnly = false } = {}) {
  return DATA.questions.filter((question) => question.role !== 'hold' && questionMatchesScope(DATA, question, scope) &&
    (direction === 'all' || question.category !== 'terms' || question.direction === direction) &&
    (!mistakesOnly || (state.skills[skillKey(question)]?.lastWrongAt > 0 && state.skills[skillKey(question)].lastWrongAt >= state.skills[skillKey(question)].lastIndependentAt)));
}

function scopeAvailability(scope) {
  const cardCount = DATA.cards.filter((card) => cardMatchesScope(card, scope)).length;
  const count = availableQuestions(scope).length;
  return count ? `范围内 ${cardCount} 个知识点，${count} 道可练题目。` : '这个范围暂无可练题目。请调整范围；系统不会混入其他等级或语言凑题。';
}

function updateScopePreview(prefix) {
  const mode = $(`#${prefix}-level-mode`);
  const grade = $(`#${prefix}-level`);
  if (grade && mode) grade.disabled = mode.value === 'all';
  const status = $(`#${prefix}-scope-count`);
  if (!status) return;
  try {
    const scope = readScope(prefix, prefix === 'practice' ? practiceCategory : 'all');
    if (prefix === 'practice') {
      practiceScope = scope;
      const count = availableQuestions(scope, { direction: practiceDirection, mistakesOnly: practiceMode === 'mistakes' }).length;
      status.textContent = count ? `当前范围有 ${count} 道可练题目；本次最多 ${Math.min(count, practiceCount)} 题。` : '当前范围暂无符合条件的题目。可以调整范围，不会混入其他内容凑题。';
    } else if (prefix === 'quiz') {
      quizScope = scope;
      const count = availableQuestions(scope).length;
      status.textContent = count ? `当前范围有 ${count} 道可用题目，本次 ${Math.min(count, quizCount)} 题，每题 1 分。题目不足时按实际数量出题。` : '这个范围暂无可测验的题目。请调整范围；不会混入其他级别或语言凑题。';
    } else status.textContent = scopeAvailability(scope);
  } catch (error) { status.textContent = error.message; }
}

function resetPracticeScope() {
  practiceScope = getStudyScope(state);
  practiceCategory = practiceScope.category;
}

function showStudyScope() {
  stopPlayback();
  currentDialogCard = null;
  const scope = normalizeScope(state.settings.studyScope);
  openDialog('这次想学什么？', `<p class="small muted">选好后，首页会重新安排这组学习。以后也会记住这个范围，你可以随时改。${state.activeSession && !state.activeSession.completed ? '正在做的练习保持原样，新范围从下一组开始。' : ''}</p>${scopeEditor('study', scope)}<p id="study-scope-count" class="notice small" role="status">${esc(scopeAvailability(scope))}</p><div class="dialog-actions">${button('save-study-scope', '用这个范围安排', 'primary-button', 'data-testid="save-study-scope"')}</div><p class="small muted">默认专项练习和按范围测验也会采用这个范围，已有学习记录保留。</p>`);
}

function levelMilestoneMarkup(row) {
  const title = row.complete ? `你已掌握本应用第 ${row.level} 级全部术语${row.nextLevel ? `，可以开始第 ${row.nextLevel} 级了。` : '，继续保持！'}` : `第 ${row.level} 级曾经达标，当前还有 ${Math.max(row.needsReview || 0, row.total - row.mastered)} 个术语需要再巩固。`;
  return `<section class="notice mastery-notice ${row.complete ? '' : 'warm'}" data-testid="level-mastery-${row.level}"><h3>${esc(title)}</h3><p>本级全部术语的两个记忆方向都要经过跨日间隔复习达标。${row.complete ? '' : '之前的达标记录仍会保留。'}第 ${row.level} 级仍在复习池中，到期后继续复习。</p>${row.complete && row.nextLevel ? button('next-level', `选择第 ${row.nextLevel} 级学习`, 'secondary-button', `data-level="${row.nextLevel}" data-testid="next-level-${row.level}"`) : ''}</section>`;
}

function masteryNotices() {
  return summarizeTermLevels(DATA, state).filter((row) => row.complete || row.achievedAt).map(levelMilestoneMarkup).join('');
}

function termLevelsMarkup() {
  const levels = summarizeTermLevels(DATA, state);
  return `<section class="panel spacer"><h2>术语，一级一级掌握</h2><p class="small muted">每个词的“外文认中文”和“中文找外文”都完成 3 次独立间隔正确作答、且没有待巩固错误，才计为双向达标。同一天重复作答、只看过卡片都不算整级掌握。统计包含本级全部语言。</p><div class="mastery-levels">${levels.map((row) => `<div class="mastery-level" data-testid="level-progress-${row.level}"><div class="row"><strong>第 ${row.level} 级</strong><span class="small">${row.mastered} / ${row.total} 个术语双向达标</span></div><div class="progress-track"><span style="width:${row.mastered / Math.max(1, row.total) * 100}%"></span></div><p class="small muted">${row.complete ? '全部达标，仍继续间隔复习。' : row.achievedAt ? '曾达标；近期有需要再巩固的内容。' : '继续学习，达到标准后会提示你进入下一级。'}${row.unsupported ? ` 当前题库有 ${row.unsupported} 个术语缺少完整双向题，暂不能判为全级掌握。` : ''}${row.dueCount ? ` 到期复习 ${row.dueCount} 项。` : ''}</p></div>`).join('')}</div></section>`;
}

function resumeBlock() {
  const session = state.activeSession;
  if (!session || session.completed) return '';
  const modeName = sessionName(session);
  return `<div class="notice row"><span>你有一份未完成的${modeName}，进度已保留。</span>${button('resume', `继续 · 第 ${Math.min(session.index + 1, session.questionIds.length)} 题`, 'ghost-button', 'data-testid="resume-session"')}</div>`;
}

function offlineStatusText() {
  return pwaStatus.ready ? '离线资源已准备' : pwaStatus.message || '首次使用请等待资源准备';
}

function renderHome() {
  const summary = summarize(DATA, state);
  const plan = buildDailyPlan(DATA, state);
  const count = plan.items.length;
  const scoped = state.settings.studyMode === 'scoped';
  const continuedNew = summary.todayAnswers > 0 && plan.newCount > 0 && !plan.dueCount && !plan.retryCount;
  const scope = getStudyScope(state);
  const scopeHasQuestions = availableQuestions(scope).length > 0;
  const active = state.activeSession && !state.activeSession.completed ? state.activeSession : null;
  const startText = count ? `${active ? '另开一组' : '开始学习'} · ${count} 项` : scopeHasQuestions ? '看看今天的记录' : '换个学习范围';
  const startAction = count ? 'start-daily' : scopeHasQuestions ? 'go-report' : 'edit-study-scope';
  const composition = [[plan.dueCount, '到期复习'], [plan.retryCount, '再试一次'], [plan.newCount, '新知识'], [plan.extensionCount, '换个角度']].filter(([n]) => n).map(([n, label]) => `<span><strong>${n}</strong> ${label}</span>`).join('<span class="plan-plus" aria-hidden="true">＋</span>');
  return `${active ? `<section class="home-resume panel" aria-label="继续上次学习"><span class="eyebrow">进度已保留</span><h1>接着上次，继续学</h1><p>${esc(sessionName(active))} · 第 ${Math.min(active.index + 1, active.questionIds.length)} / ${active.questionIds.length} 项${isAssessment(active) && active.deadline ? ' · 计时仍在继续' : ''}</p>${active.scope ? `<p class="small muted">上次范围：${esc(scopeLabel(active.scope))}</p>` : ''}${button('resume', `继续上次学习 ${icon('arrow')}`, 'primary-button full', 'data-testid="resume-session"')}</section>` : ''}
    <section class="panel home-plan study-planner" aria-label="学习安排">
      <div class="home-plan-heading"><span class="eyebrow">${esc(todayLabel())}</span>${active ? '<h2>下一组的安排</h2><p>更改这里，不会改变正在做的练习。</p>' : count ? '<h1>今天，先学这一组</h1><p>已经帮你排好了，点“开始学习”就可以。</p>' : '<h1>今天，按自己的节奏</h1><p>看看当前安排，也可以换个范围。</p>'}</div>
      <div class="study-mode-grid" aria-label="安排方式">
        <button type="button" data-action="study-mode-auto" data-testid="study-mode-auto" class="study-mode ${scoped ? '' : 'selected'}" aria-pressed="${!scoped}"><strong>自动安排</strong><span>系统帮我选内容</span></button>
        <button type="button" data-action="study-mode-scoped" data-testid="study-mode-scoped" class="study-mode ${scoped ? 'selected' : ''}" aria-pressed="${scoped}"><strong>自己选范围</strong><span>指定级别和语言</span></button>
      </div>
      <div class="home-scope ${scoped ? 'has-edit' : ''}"><span class="small muted" data-testid="study-mode-label">${scoped ? '按范围安排' : '自动安排'}</span><p data-testid="study-scope-summary">${scoped ? esc(scopeLabel(scope)) : '从全部学习记录中安排，先复习，再学新内容。'}</p>${scoped ? button('edit-study-scope', '修改范围', 'ghost-button', 'data-testid="edit-study-scope"') : ''}</div>
      ${!scopeHasQuestions ? '<p class="notice warm" data-testid="empty-study-scope">这个范围还没有可练题目，换个范围再开始吧。</p>' : ''}
      <div class="home-plan-content" data-testid="home-plan-composition">${count ? `<span class="small muted">${scoped ? '只学上面选的范围' : '这一组的内容'}</span><div class="plan-counts">${composition}</div>` : scopeHasQuestions ? '<p>当前范围暂时没有待做任务。可以休息一下，也可以自己挑内容学。</p>' : ''}</div>
      ${button(startAction, `${startText} ${icon('arrow')}`, `${active ? 'secondary-button' : 'primary-button'} full`, 'data-testid="start-daily"')}
      <p class="home-plan-footnote">${count ? '做完这一组就可以休息，想继续时再开下一组。' : '学习记录会保留，之后到期的内容会继续安排。'}</p>
      ${plan.remainingDueCount ? `<p class="small muted">范围内另有 ${plan.remainingDueCount} 项到期内容，可以分组完成。</p>` : ''}
      ${continuedNew ? '<p class="small muted" data-testid="next-new-group">当前范围没有到期复习，这组可以继续学新内容。</p>' : ''}
    </section>
    ${plan.outsideDueCount ? `<details class="home-extra-review" data-testid="outside-due-notice"><summary data-testid="outside-review-toggle">范围外还有 ${plan.outsideDueCount} 项待复习 <span>可另外安排</span></summary><div><p>上面这一组只按你选的范围安排。想复习以前学过的其他内容时，可以在这里另开一组。</p><p class="small muted">下面的入口不限范围，只安排到期复习和短时重测，最多 15 项，不加入新知识，也不改你的学习范围。刚复习过的内容会更新进度，不需要把同一份复习再做一遍。</p>${button('review-all-due', '只复习已学内容（不限范围）', 'secondary-button', 'data-testid="review-all-due"')}</div></details>` : ''}
    ${!hasLearningRecords({ state, ...recordCounts(state) }) ? storageHelpMarkup() : ''}
    <p class="home-today small muted">今天已作答 ${summary.todayAnswers || 0} 题 · 已接触 ${summary.learned || 0} 个知识点</p>
    ${masteryNotices()}
    <div class="section-title"><h2>也可以自己挑内容</h2><span class="small muted">按需选择</span></div>
    <div class="grid-3 topics-grid">${Object.entries(CAT).map(([id, name], i) => `<button type="button" class="topic-card" data-action="browse-category" data-category="${id}"><span class="topic-symbol">${['a tempo', '♬', '◖ ◗'][i]}</span><h3>${name}</h3><p>${['意 · 法 · 德，听懂谱面的提示', '看清记号，读懂怎样演奏', '家族、发声与高低音域'][i]}</p><span class="go">${icon('arrow')}</span></button>`).join('')}</div>
    <div class="grid-2 spacer"><section class="panel"><span class="eyebrow">YOUR PACE</span><h2>慢慢来，记得更牢</h2><p class="muted small">答错的内容会再次出现；还没到复习时间的知识，不用抢着刷。今天没有到期任务时，也可以自主学习。</p><div class="progress-track"><span style="width:${Math.min(100, (summary.learned || 0) / DATA.cards.length * 100)}%"></span></div><p class="small muted">已接触 ${summary.learned || 0} / ${DATA.cards.length} 个知识点</p></section><section class="panel"><span class="eyebrow">A LITTLE CHECK-IN</span><h2>按自己的范围，小测一次</h2><p class="muted small">选好等级和语言，独立完成后统一交卷。也可以尝试五级第六部分模拟。</p><div class="row">${button('go-quiz', `按范围测验 ${icon('arrow')}`, 'secondary-button', 'data-testid="go-quiz"')}${button('go-exam', '五级第六部分模拟', 'ghost-button')}</div></section></div>
    <div class="notice row audio-trial-banner"><p>已内置 ${recordingsByCard.size} 个术语读音，打开知识卡片即可听普通或慢速。</p><div class="row">${button('browse-category', `${icon('sound')} 去知识页听读音`, 'secondary-button', 'data-category="terms" data-testid="open-audio-terms"')}${button('go-audio', '试听3个读音样本', 'ghost-button', 'data-testid="open-audio-samples"')}</div></div>
    <p class="footer-note">V1.1.1 · ${uiStorageStatus().durable ? '学习记录保存在这台设备' : '本次记录只在本页暂存'} · <span id="home-offline-status">${esc(offlineStatusText())}</span></p>`;
}

function renderLearn() {
  const scope = normalizeScope({ category, levelMode: level === 'all' ? 'all' : 'exact', level: level === 'all' ? 1 : Number(level), languages: language === 'all' ? Object.keys(LANG) : [language] });
  let filtered = DATA.cards.filter((card) => cardMatchesScope(card, scope));
  if (search.trim()) {
    const query = search.trim().toLocaleLowerCase();
    filtered = filtered.filter((card) => `${card.title} ${card.meaning} ${(card.facts || []).map((fact) => fact.value).join(' ')}`.toLocaleLowerCase().includes(query));
  }
  return `<div class="heading-row"><div><span class="eyebrow">KNOWLEDGE NOTEBOOK</span><h1>先认识，再记住</h1><p>翻开一张卡片，试着说出它的意思。</p></div><span class="pill">${DATA.cards.length} 个知识点</span></div>
    <div class="chip-row">${[['all', '全部'], ...Object.entries(CAT)].map(([id, title]) => `<button class="chip ${category === id ? 'selected' : ''}" data-action="filter-category" data-category="${id}" type="button">${title}</button>`).join('')}</div>
    <div class="filters"><div class="field search-field"><label for="knowledge-search">找一个知识点</label><input id="knowledge-search" data-testid="knowledge-search" type="search" placeholder="术语、中文意思或乐器名称" value="${esc(search)}"></div><div class="field"><label for="knowledge-level">教材级别</label><select id="knowledge-level"><option value="all">全部级别</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${level === String(n) ? 'selected' : ''}>第 ${n} 级</option>`).join('')}</select></div><div class="field"><label for="knowledge-language">术语语言</label><select id="knowledge-language"><option value="all">全部语言</option>${Object.entries(LANG).map(([id, text]) => `<option value="${id}" ${language === id ? 'selected' : ''}>${text}</option>`).join('')}</select></div></div>
    <div class="notice scope-summary"><p>找到 ${filtered.length} 项 · 术语语言只筛选音乐术语；低级别知识也属于五级累计范围。${search.trim() ? ' 保存学习范围只采用类别、级别和语言，不包含搜索词。' : ''}</p>${button('use-knowledge-scope', '设为我的学习范围', 'secondary-button', 'data-testid="use-knowledge-scope"')}</div>
    ${filtered.length ? `<div class="knowledge-grid">${filtered.slice(0, visibleCards).map((card) => `<button class="knowledge-item" type="button" data-action="open-card" data-card="${esc(card.id)}" data-testid="knowledge-card"><span class="pill">${esc(card.language ? LANG[card.language] || card.language : CAT[card.category])}${card.level ? ` · ${card.level}级` : ''}</span><span class="term">${esc(card.title)}</span>${card.category === 'signs' && card.images?.[0] ? `<img class="mini-image" src="${esc(card.images[0].src)}" alt="${esc(card.title)}的谱图" loading="lazy">` : ''}<span class="meta">${state.learned[card.id] ? '<i class="learned-dot"></i>已经看过' : '想一想，它是什么意思？'}</span><span class="small-arrow">↗</span></button>`).join('')}</div>${filtered.length > visibleCards ? button('more-cards', '再看一些', 'secondary-button load-more') : ''}` : empty('暂时没有找到', '试试更短的词，或切换到全部级别和语言。')}`;
}

function sourcesMarkup(sources = []) {
  if (!sources.length) return '';
  return `<details class="source-list"><summary>知识来源</summary>${sources.map((source) => `<p>${esc(source.authority === 'official_textbook_user_confirmed' || String(source.sourceId).startsWith('official-') ? '官方教材' : source.authority === 'official_website' ? 'ABRSM 官方网站' : '教辅参考资料')}${source.grade ? ` · 第${esc(source.grade)}级` : ''}${source.page ? ` · 第${esc(source.page)}页` : ''}${source.url && /^https?:\/\//.test(source.url) ? ` · <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">查看来源</a>` : ''}</p>`).join('')}</details>`;
}

function imagesMarkup(images = []) {
  return images.length ? `<div class="study-images">${images.map((image) => `<figure><img src="${esc(image.src)}" alt="${esc(image.caption || '知识谱图')}" loading="lazy">${image.caption ? `<figcaption>${esc(image.caption)}</figcaption>` : ''}</figure>`).join('')}</div>` : '';
}

function speechSupported() {
  return typeof window.speechSynthesis?.getVoices === 'function' && typeof window.SpeechSynthesisUtterance === 'function';
}

function localVoice(card) {
  const code = LANGUAGE_CODES[card.language];
  if (!speechSupported() || !code) return null;
  return speechVoices.find((voice) => voice.localService === true && String(voice.lang || '').toLowerCase().split(/[-_]/)[0] === code) || null;
}

function audioKindLabel(recording) {
  return recording.kind === 'synthesized' ? '离线合成读音' : recording.kind === 'recording' ? '真人录音' : '内置音频';
}

function audioHint(card) {
  const recording = recordingsByCard.get(card.id);
  if (speechErrors.has(card.id)) return speechErrors.get(card.id);
  if (recording) {
    const kind = audioKindLabel(recording);
    if (activeAudioCard === card.id) return audioLoading ? `正在载入${kind}…` : `正在播放${kind}。`;
    return `${kind}：${recording.title || card.title}。普通原速，慢速为 0.75 倍播放；读音不计分。`;
  }
  const languageName = LANG[card.language] || card.language || '该语言';
  const unavailableNotice = '此词暂未内置音频。';
  if (voiceStatus === 'unsupported') return `${unavailableNotice}当前浏览器不支持本机语音朗读；不影响学习和答题。`;
  if (localVoice(card)) return `${unavailableNotice}此处使用本机${languageName}语音辅助记忆，读音不计分。`;
  if (voiceStatus === 'loading') return `${unavailableNotice}正在读取本机语音，请稍候。`;
  return `${unavailableNotice}浏览器尚未提供${languageName}的本地语音；不影响学习和答题。`;
}

function audioSourceMarkup(recording) {
  const link = (url, text) => /^https?:\/\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
  const synthesized = recording.kind === 'synthesized';
  return `<details class="source-list audio-source" data-audio-source><summary>${synthesized ? '音源与使用说明' : '录音来源与使用说明'}</summary><p>${audioKindLabel(recording)}：${esc(recording.title)}</p><p>${synthesized ? '音源' : '作者'}：${esc(recording.author)}</p>${synthesized || recording.spokenText ? `<p>朗读文本：${esc(recording.spokenText || recording.title)}</p>` : ''}<p>来源：${link(recording.sourceUrl, synthesized ? '音源模型页面' : '原始录音页面')}</p><p>${synthesized ? '音源许可' : '许可'}：${link(recording.licenseUrl, recording.license)}</p><p>音频处理：${esc(recording.modification || '转为 MP3 供本应用播放。')}</p>${synthesized ? '<p>读音由本机离线生成后随应用内置；播放时不调用语音生成服务。</p>' : ''}<p>慢速按钮以 0.75 倍播放同一音频，并尽量保持音高。读音辅助记忆，尚未完成逐条人工听审。</p></details>`;
}

function audioMarkup(card) {
  const recording = recordingsByCard.get(card.id);
  const enabled = recording || localVoice(card);
  return `<div data-audio-card="${esc(card.id)}" data-audio-kind="${esc(recording?.kind || 'local-voice')}">${recording ? `<p class="small"><span class="pill" data-audio-kind-label>${audioKindLabel(recording)}</span></p>` : ''}<div class="audio-row">${button('speak', `${icon('sound')} 听读音`, 'secondary-button', `data-card="${esc(card.id)}" data-rate="${recording ? '1' : '0.9'}" ${enabled ? '' : 'disabled'}`)}${button('speak', '慢一点', 'secondary-button', `data-card="${esc(card.id)}" data-rate="${recording ? '0.75' : '0.65'}" ${enabled ? '' : 'disabled'}`)}</div><p class="audio-hint" data-audio-status role="status">${esc(audioHint(card))}</p>${recording ? audioSourceMarkup(recording) : `${button('retry-voices', '重新检测本机语音', 'text-button')}${button('go-audio', '试听3个内置样本', 'text-button')}`}</div>`;
}

function renderAudio() {
  return `<section data-testid="audio-samples"><div class="heading-row"><div><span class="eyebrow">LISTEN TO THREE WORDS</span><h1>先听听这三个词</h1><p>已内置 ${recordingsByCard.size} 个术语读音，可在知识页逐词播放。这里保留意大利语、德语、法语各 1 条真人录音样本。</p></div></div><p class="notice">先听普通读音，再试慢速。试听不会标记掌握或修改学习记录。</p><div class="audio-sample-grid spacer">${audioSamples.map((sample) => {
    const card = cards.get(sample.cardId);
    return `<section class="panel audio-sample-card" data-testid="audio-sample" data-card="${esc(card.id)}"><h2>${esc(LANG[sample.language] || LANG[card.language] || sample.language)}</h2><h3 class="study-title">${esc(sample.title || card.title)}</h3>${audioMarkup(card)}</section>`;
  }).join('') || empty('录音样本尚未准备好', '请稍后重新打开本页。')}</div><div class="row spacer">${button('browse-category', '去知识页听全部术语', 'primary-button', 'data-category="terms" data-testid="open-audio-terms"')}${button('go-home', `${icon('back')} 回到今天`, 'ghost-button')}</div></section>`;
}

function refreshAudioAreas() {
  // Update only audio controls, preserving revealed answers, session DOM and focus.
  document.querySelectorAll('[data-audio-card]').forEach((area) => {
    const card = cards.get(area.dataset.audioCard);
    if (!card) return;
    const enabled = recordingsByCard.has(card.id) || Boolean(localVoice(card));
    area.querySelectorAll('[data-action="speak"]').forEach((control) => { control.disabled = !enabled; });
    const hint = area.querySelector('[data-audio-status]');
    const message = audioHint(card);
    if (hint.textContent !== message) hint.textContent = message;
  });
}

function stopPlayback() {
  playbackToken++;
  const previousAudio = activeAudio;
  activeAudio = null;
  activeAudioCard = null;
  audioLoading = false;
  if (previousAudio) {
    previousAudio.onplaying = previousAudio.onended = previousAudio.onerror = null;
    previousAudio.pause();
    try { previousAudio.currentTime = 0; } catch {}
    previousAudio.remove();
  }
  if (activeUtterance) {
    activeUtterance = null;
    try { window.speechSynthesis?.cancel(); } catch {}
  }
  refreshAudioAreas();
}

function playSample(card, sample, rate) {
  stopPlayback();
  speechErrors.delete(card.id);
  const token = playbackToken;
  let audio;
  const reportError = (error) => {
    if (token !== playbackToken || (audio && activeAudio !== audio)) return;
    activeAudioCard = null;
    audioLoading = false;
    audio?.pause();
    const message = error?.name === 'NotAllowedError'
      ? '浏览器未允许这次播放，请再次点击“听读音”重试。'
      : audio?.error?.code === 2
        ? '音频暂时无法载入，请联网后再次点击“听读音”重试。'
        : '这条音频暂时未能播放，请再次点击“听读音”重试。';
    speechErrors.set(card.id, message);
    refreshAudioAreas();
    toast(message);
  };
  try {
    const url = new URL(sample.src, document.baseURI);
    if (url.origin !== location.origin || !['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error('Audio must use this site.');
    audio = document.createElement('audio');
    audio.id = 'sample-audio-player';
    audio.dataset.card = card.id;
    audio.hidden = true;
    audio.preload = 'none';
    audio.src = url.href;
    audio.playbackRate = rate === 0.75 ? 0.75 : 1;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.mozPreservesPitch = true;
    activeAudio = audio;
    activeAudioCard = card.id;
    audioLoading = true;
    audio.onplaying = () => {
      if (activeAudio !== audio || token !== playbackToken) return;
      audioLoading = false;
      refreshAudioAreas();
    };
    audio.onended = () => {
      if (activeAudio !== audio || token !== playbackToken) return;
      activeAudioCard = null;
      audioLoading = false;
      refreshAudioAreas();
    };
    audio.onerror = reportError;
    document.body.append(audio);
    refreshAudioAreas();
    // Call play directly during the click gesture; never wait for a fetch or decode first.
    const playback = audio.play();
    if (playback?.catch) playback.catch(reportError);
  } catch (error) { reportError(error); }
}

function refreshVoices(complete = false) {
  if (!speechSupported()) {
    speechVoices = [];
    voiceStatus = 'unsupported';
    clearTimeout(voiceLoadTimer);
  } else {
    try { speechVoices = Array.from(window.speechSynthesis.getVoices()); }
    catch { speechVoices = []; }
    if (speechVoices.length || complete) {
      voiceStatus = 'ready';
      clearTimeout(voiceLoadTimer);
    }
  }
  refreshAudioAreas();
}

function detectVoices() {
  clearTimeout(voiceLoadTimer);
  speechErrors.clear();
  voiceStatus = 'loading';
  voiceLoadTimer = setTimeout(() => refreshVoices(true), 2000);
  refreshVoices();
}

function speakCard(card, rate) {
  refreshVoices();
  const voice = localVoice(card);
  if (!voice) { toast(audioHint(card)); return; }
  speechErrors.delete(card.id);
  refreshAudioAreas();
  stopPlayback();
  const utterance = new window.SpeechSynthesisUtterance(card.title.replace(/\s*\([^)]*\)/g, ''));
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = rate === 0.65 ? 0.65 : 0.9;
  const reportError = (error) => {
    if (activeUtterance !== utterance) return;
    activeUtterance = null;
    if (['canceled', 'interrupted'].includes(error)) return;
    const languageName = LANG[card.language] || card.language || '该语言';
    const message = error === 'not-allowed'
      ? '浏览器未允许这次朗读，请再次点击“听读音”。'
      : ['audio-busy', 'audio-hardware'].includes(error)
        ? '暂时无法播放声音，请检查设备音量和音频输出后重试。'
        : `${languageName}本机语音这次未能播放，请重新检测后再试。`;
    speechErrors.set(card.id, message);
    refreshAudioAreas();
    toast(message);
  };
  utterance.onerror = (event) => reportError(event.error);
  utterance.onend = () => { if (activeUtterance === utterance) activeUtterance = null; };
  activeUtterance = utterance;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch { reportError('synthesis-failed'); }
}

function cardMarkup(card, { study = false, forceReveal = false } = {}) {
  const isRevealed = forceReveal || revealed.has(card.id);
  const related = (card.relatedIds || []).map((id) => cards.get(id)).filter(Boolean);
  return `<div class="row"><span class="pill">${esc(CAT[card.category])}</span>${card.language ? `<span class="pill coral">${esc(LANG[card.language] || card.language)}</span>` : ''}${card.level ? `<span class="small muted">教材第 ${esc(card.level)} 级</span>` : ''}</div><h3 class="study-title">${esc(card.title)}</h3>${card.category === 'terms' ? audioMarkup(card) : imagesMarkup(card.images || [])}
    ${isRevealed ? `<div class="meaning" data-testid="card-meaning">${esc(card.meaning || '')}</div>${card.explanation ? `<p class="muted">${esc(card.explanation)}</p>` : ''}${(card.facts || []).length ? `<ul class="facts">${card.facts.map((fact) => `<li><span class="label">${esc(fact.label)}</span><span>${esc(fact.value)}${fact.scope ? `<small class="scope">${esc(fact.scope)}</small>` : ''}</span></li>`).join('')}</ul>` : ''}${related.length ? `<h3 class="small">一起比较，更容易记住</h3><div class="related-list">${related.slice(0, 12).map((item) => `<button type="button" class="text-button" data-action="open-card" data-card="${esc(item.id)}">${esc(item.title)}</button>`).join('')}</div>` : ''}${sourcesMarkup(card.sources)}<div class="row spacer">${button(study ? 'begin-recall' : 'mark-learned', `${study ? '看懂了，开始回忆' : '我看懂了'} ${icon('check')}`, 'primary-button', `data-card="${esc(card.id)}" data-testid="${study ? 'begin-recall' : 'mark-learned'}"`)}${!study ? button('practice-card', '练一练这个知识', 'secondary-button', `data-card="${esc(card.id)}"`) : ''}</div>` : `<div class="reveal-panel"><p>先试着说出它的意思，再翻开答案。</p>${button('reveal-card', '翻开看看', 'primary-button', `data-card="${esc(card.id)}" data-testid="reveal-card"`)}</div>`}`;
}

function showCard(id) {
  const card = cards.get(id);
  if (!card) return;
  if (currentDialogCard !== id) stopPlayback();
  currentDialogCard = id;
  openDialog('知识卡片', cardMarkup(card));
}

function renderPractice() {
  if (!practiceScope) resetPracticeScope();
  const scope = normalizeScope({ ...practiceScope, category: practiceCategory });
  const available = availableQuestions(scope, { direction: practiceDirection, mistakesOnly: practiceMode === 'mistakes' }).length;
  return `<div class="heading-row"><div><span class="eyebrow">PRACTICE AT YOUR PACE</span><h1>一次，练明白一点</h1><p>答完一题就看解释，把不确定的地方弄清楚。</p></div></div>${resumeBlock()}<div class="setup-grid spacer"><section class="panel practice-setup"><h2>${practiceMode === 'mistakes' ? '回到容易出错的地方' : '选择这次练习范围'}</h2><p class="small muted">默认采用你的学习安排。这里临时修改，不会改变首页保存的范围。</p>${button('reset-practice-scope', '重新使用首页学习范围', 'ghost-button', 'data-testid="reset-practice-scope"')}<div class="choice-group">${[['all', '混合练习'], ...Object.entries(CAT)].map(([id, title]) => `<button class="chip ${practiceCategory === id ? 'selected' : ''}" type="button" data-action="practice-category" data-category="${id}">${title}</button>`).join('')}</div>${scopeEditor('practice', scope, { includeCategory: false })}<div class="field"><label for="practice-direction">术语考查方向</label><select id="practice-direction"><option value="all">两种方向都练</option><option value="term_to_meaning" ${practiceDirection === 'term_to_meaning' ? 'selected' : ''}>外文 → 中文意思</option><option value="meaning_to_term" ${practiceDirection === 'meaning_to_term' ? 'selected' : ''}>中文意思 → 外文</option></select><span class="small muted">方向只影响术语；其他板块按各自考点练习。</span></div><div class="field"><label for="practice-count">这次练几题</label><select id="practice-count">${[5, 10, 15, 20].map((n) => `<option value="${n}" ${practiceCount === n ? 'selected' : ''}>${n} 题</option>`).join('')}</select></div><label class="check-label"><input id="mistakes-only" type="checkbox" ${practiceMode === 'mistakes' ? 'checked' : ''}><span>只练尚需巩固的错题</span></label><p id="practice-scope-count" class="notice small" role="status">${available ? `当前范围有 ${available} 道可练题目；本次最多 ${Math.min(available, practiceCount)} 题。` : '当前范围暂无符合条件的题目。可以调整范围，不会混入其他内容凑题。'}</p>${button('start-practice', `开始练习 ${icon('arrow')}`, 'primary-button full spacer', 'data-testid="start-practice"')}</section><aside class="side-note"><span class="eyebrow">A GOOD WAY TO LEARN</span><h3>别急着猜。</h3><div class="intro-step"><span>1</span><div><strong>先认真想一想</strong><p>选项位置会变化，要判断意思。</p></div></div><div class="intro-step"><span>2</span><div><strong>看懂为什么</strong><p>答错也没关系，解释会帮你找回知识。</p></div></div><div class="intro-step"><span>3</span><div><strong>隔一会儿再试</strong><p>短时重测和隔天复习，分别记录。</p></div></div><p class="small muted">专项练习包含辅助巩固题，和五级模拟的选题用途不同。</p>${button('go-quiz', '按这个范围做测验', 'secondary-button', 'data-testid="practice-go-quiz" data-use-practice="true"')}</aside></div>`;
}

function renderQuiz() {
  if (!quizScope) quizScope = getStudyScope(state);
  const scope = normalizeScope(quizScope);
  const count = availableQuestions(scope).length;
  if (quizMinutes === null) quizMinutes = Number(state.settings.examMinutes);
  return `<div class="heading-row"><div><span class="eyebrow">YOUR OWN LITTLE QUIZ</span><h1>按范围，小测一次</h1><p>选好范围，独立作答后一起检查。</p></div><span class="pill">已完成 ${state.quizzes.length} 次</span></div>${resumeBlock()}<div class="setup-grid spacer"><section class="panel practice-setup"><h2>这次想检验什么？</h2><p class="small muted">初始采用首页学习范围。这里的临时选择不会修改日常安排。</p>${button('reset-quiz-scope', '重新使用首页学习范围', 'ghost-button', 'data-testid="reset-quiz-scope"')}${scopeEditor('quiz', scope)}<div class="scope-grade-fields"><div class="field"><label for="quiz-count">最多几题</label><select id="quiz-count">${[5, 10, 15, 20].map((n) => `<option value="${n}" ${quizCount === n ? 'selected' : ''}>${n} 题</option>`).join('')}</select></div><div class="field"><label for="quiz-minutes">测验计时</label><select id="quiz-minutes">${[0, 5, 10, 15, 20].map((n) => `<option value="${n}" ${quizMinutes === n ? 'selected' : ''}>${n ? `${n} 分钟` : '不设时限'}</option>`).join('')}</select></div></div><p id="quiz-scope-count" class="notice small" role="status">${count ? `当前范围有 ${count} 道可用题目，本次 ${Math.min(count, quizCount)} 题，每题 1 分。题目不足时按实际数量出题。` : '这个范围暂无可测验的题目。请调整范围；不会混入其他级别或语言凑题。'}</p>${button('start-quiz', `准备好了，开始测验 ${icon('arrow')}`, 'primary-button full spacer', 'data-testid="start-quiz"')}</section><aside class="side-note"><h3>先完成，<br>再看答案。</h3><ul><li>可以跳题、标记，交卷前随时修改答案。</li><li>离开页面后可以继续；设定的计时仍会走。</li><li>交卷后结果计入学习记录，答错内容进入复习池。</li></ul><p class="small muted">这是所选范围的家庭测验，不是某一级的完整考试，也不代表整级已经掌握。</p>${button('go-exam', '查看五级第六部分模拟', 'ghost-button')}</aside></div>`;
}

function renderExam() {
  const examCount = state.exams.length;
  return `<div class="heading-row"><div><span class="eyebrow">SECTION SIX · A LITTLE REHEARSAL</span><h1>第六部分，小小排练</h1><p>五级第六部分固定结构，累计范围。总共 10 分。</p></div><span class="pill">已完成 ${examCount} 次</span></div>${resumeBlock()}<div class="notice row"><p>想只练某一级或某种语言？进入按范围测验，选择自己的范围。</p>${button('go-quiz', '按范围测验', 'secondary-button', 'data-testid="go-quiz"')}</div><div class="setup-grid spacer"><section class="exam-paper"><span class="eyebrow">YOUR PRACTICE PAPER</span><h2>今天的 10 个小挑战</h2>${[['01', '术语与标记', '3 题 · 3 分'], ['02', '看谱辨认装饰音', '2 题 · 2 分'], ['03', '乐器与人声判断', '5 题 · 5 分']].map(([n, title, count]) => `<div class="exam-layout-row"><div><span>${n}</span><h3>${title}</h3></div><strong>${count}</strong></div>`).join('')}<div class="field spacer"><label for="exam-minutes">练习计时</label><select id="exam-minutes">${[0, 5, 10, 15, 20].map((n) => `<option value="${n}" ${Number(state.settings.examMinutes) === n ? 'selected' : ''}>${n ? `${n} 分钟，到时自动交卷` : '不设时限'}</option>`).join('')}</select></div>${button('start-exam', `准备好了，开始 ${icon('arrow')}`, 'primary-button full spacer', 'data-testid="start-exam"')}</section><aside class="side-note"><h3>像考试一样，<br>认真读每一道题。</h3><ul><li>可以跳过暂时不确定的题，标记后再回来。</li><li>提交前不会提示对错；提交后显示分项得分和解释。</li><li>离开页面后可继续，设定的计时仍会走。</li></ul><p class="small muted">采用已核对题库的家庭模拟练习，参照官方样卷结构；题目可能重复，不等于官方原卷或全卷成绩预测。</p></aside></div>`;
}

function stimulusMarkup(question) {
  const stimulus = question.stimulus;
  if (!stimulus) return '';
  if (stimulus.kind === 'image') return `<figure class="question-stimulus"><img src="${esc(stimulus.src)}" alt="${esc(stimulus.alt || '请观察题目谱图')}" data-testid="question-image"></figure>`;
  if (stimulus.kind === 'text') return `<div class="question-stimulus text">${esc(stimulus.text)}</div>`;
  return '';
}

function renderSession() {
  const session = state.activeSession;
  const qid = session.questionIds[session.index];
  const question = questions.get(qid);
  if (!question) return empty('这份练习需要重新开始', '题库版本已经变化。已保存的学习历史仍在。', button('go-home', '回到今天'));
  const isExam = isAssessment(session);
  const isNew = session.kinds?.[qid] === 'new' && !session.studied?.[qid];
  const studyCard = question.knowledgeIds.map((id) => cards.get(id)).find(Boolean);
  if (!isExam && isNew && studyCard) return `<div class="session-shell"><div class="session-top">${button('pause-session', `${icon('back')} ${isExam && session.deadline ? '离开（继续计时）' : '稍后继续'}`, 'ghost-button')}<span class="pill">先学，再试</span></div><section class="question-panel">${cardMarkup(studyCard, { study: true })}</section></div>`;
  const feedback = !isExam && session.feedback?.questionId === qid ? session.feedback : null;
  const answer = session.answers[qid];
  const order = session.optionOrders[qid] || question.options.map((item) => item.id);
  const options = order.map((id) => question.options.find((option) => option.id === id)).filter(Boolean);
  const letter = (i) => 'ABCD'[i] || String(i + 1);
  return `<div class="session-shell"><div class="session-top">${button('pause-session', `${icon('back')} ${isExam && session.deadline ? '离开（继续计时）' : '稍后继续'}`, 'ghost-button')}<span>${esc(sessionName(session))} · ${session.index + 1} / ${session.questionIds.length}</span>${isExam && session.deadline ? '<span class="timer" id="exam-timer" aria-label="剩余时间"></span>' : ''}</div><div class="session-progress" aria-hidden="true"><span style="width:${(session.index + 1) / session.questionIds.length * 100}%"></span></div>${session.scope ? `<p class="small muted session-scope" data-testid="session-scope">本组范围：${esc(scopeLabel(session.scope))}</p>` : ''}<section class="question-panel"><div class="question-meta"><span class="eyebrow">${esc(CAT[question.category])} · ${session.kinds?.[qid] === 'extend' ? '换个角度 · ' : ''}${question.direction === 'meaning_to_term' ? '中文找外文' : question.direction === 'performed_notation_to_ornament' ? '看谱辨认' : '想一想，再作答'}</span>${isExam ? button('flag-question', session.flagged?.[qid] ? '已标记 · 再看一遍' : '标记这题', `flag-button ${session.flagged?.[qid] ? 'on' : ''}`, 'aria-pressed="' + Boolean(session.flagged?.[qid]) + '"') : ''}</div><h1 class="question-title" data-testid="question-prompt">${esc(question.prompt)}</h1>${stimulusMarkup(question)}<div class="option-list" role="group" aria-label="答案选项">${options.map((option, i) => `<button type="button" class="answer-option ${answer === option.id ? 'selected' : ''} ${feedback && option.id === question.answerId ? 'correct' : ''} ${feedback && answer === option.id && !feedback.correct ? 'incorrect' : ''}" data-action="choose-option" data-option="${esc(option.id)}" data-testid="question-option" data-option-id="${esc(option.id)}" aria-pressed="${answer === option.id}" ${feedback ? 'disabled' : ''}><span class="option-letter">${letter(i)}</span><span>${esc(option.text)}</span>${feedback && option.id === question.answerId ? '<span class="option-result">正确答案</span>' : ''}</button>`).join('')}</div>${feedback ? `<div class="feedback ${feedback.correct ? '' : 'wrong'}" data-testid="answer-feedback" role="status"><h3>${feedback.correct ? '答对了，记住这个区别。' : '这次先把它弄明白。'}</h3><p>${esc(question.explanation)}</p><p class="small">${feedback.correct ? (session.kinds?.[qid] === 'retry' ? '这是短时重测，不会提高长期记忆阶段。' : '结果已记入本题对应的考查方向。') : '约7分钟后可再测，明天还会安排复习。'}</p>${sourcesMarkup(question.sources)}</div>` : ''}<div class="session-actions">${isExam ? `${button('previous-question', '上一题', 'secondary-button', session.index === 0 ? 'disabled' : '')}${session.index < session.questionIds.length - 1 ? button('next-question', '下一题 →', 'primary-button', 'data-testid="next-question"') : button('submit-exam', '检查并交卷', 'primary-button', 'data-testid="submit-exam"')}` : feedback ? button('next-question', session.index === session.questionIds.length - 1 ? '完成这次练习' : '下一题 →', 'primary-button', 'data-testid="next-question"') : button('submit-answer', '确认答案', 'primary-button', `data-testid="submit-answer" ${answer ? '' : 'disabled'}`)}</div></section>${isExam ? `<div class="question-jump" aria-label="跳转题目">${session.questionIds.map((id, index) => `<button type="button" class="jump-button ${session.index === index ? 'current' : ''} ${session.answers[id] ? 'answered' : ''} ${session.flagged?.[id] ? 'flagged' : ''}" data-action="jump-question" data-index="${index}" aria-label="第${index + 1}题${session.answers[id] ? '，已作答' : '，未作答'}${session.flagged?.[id] ? '，已标记' : ''}">${index + 1}</button>`).join('')}</div><div class="row" style="justify-content:center">${button('submit-exam', '提前交卷', 'ghost-button', 'data-testid="submit-exam-early"')}<span class="small muted">● 表示已标记的题</span></div>` : ''}</div>`;
}

function answerReviewMarkup(question, selectedId, correct, index) {
  if (!question) return '';
  const correctText = question.options.find((option) => option.id === question.answerId)?.text || '';
  const selectedText = question.options.find((option) => option.id === selectedId)?.text || '未作答';
  return `<details class="review-answer" ${correct ? '' : 'open'}><summary><span class="${correct ? 'badge-correct' : 'badge-wrong'}">${correct ? '✓' : '○'}</span><span>${index + 1}. ${esc(question.prompt)}</span></summary><div class="answer-body">${stimulusMarkup(question)}<p>你的答案：${esc(selectedText)}</p>${!correct ? `<p><strong>正确答案：${esc(correctText)}</strong></p>` : ''}<p>${esc(question.explanation)}</p>${sourcesMarkup(question.sources)}<div class="row">${question.knowledgeIds.slice(0, 3).map((id) => cards.has(id) ? button('open-card', `再看 ${esc(cards.get(id).title)}`, 'text-button', `data-card="${esc(id)}"`) : '').join('')}</div></div></details>`;
}

function renderResult() {
  const session = state.activeSession;
  const result = lastResult || (session?.mode === 'quiz' ? state.quizzes.find((item) => item.sessionId === session.id) : session?.mode === 'exam' ? state.exams.find((item) => item.sessionId === session.id) : null);
  if (result) {
    const wrong = (result.answers || []).filter((item) => !item.correct);
    const quiz = result.mode === 'quiz';
    return `<div class="session-shell" data-testid="${quiz ? 'quiz-result' : 'exam-result'}"><div class="result-header"><span class="eyebrow">${quiz ? '按范围测验' : '五级第六部分模拟'}</span><div class="score-ring" data-testid="result-score">${result.score}<small>/ ${result.total}</small></div><h1>${result.score / Math.max(1, result.total) >= .8 ? '完成了，继续稳稳地走。' : '找到要补上的地方，就是进步。'}</h1><p class="muted">${wrong.length ? `${wrong.length}道题需要再看一看，已加入对应复习记录。` : '这份练习全部答对了。隔些时间，再检验是否还记得。'}</p>${quiz ? `<p class="small muted">本次范围：${esc(scopeLabel(result.scope))}</p>` : ''}</div><div class="result-grid">${Object.entries(CAT).filter(([id]) => result.sections[id]?.total).map(([id, name]) => `<div><strong>${result.sections[id]?.score || 0}<small> / ${result.sections[id]?.total || 0}</small></strong><span>${name}</span></div>`).join('')}</div><p class="notice small">${quiz ? '这是所选范围的测验结果，不是某一级的完整考试。单次满分不等于整级掌握，后续仍会间隔复习。' : '这是本次第六部分模拟练习的结果，不代表全卷分数或未见题表现。'}</p>${masteryNotices()}<div class="row spacer">${button('go-home', '回到今天')}${button('go-report', '查看学习记录', 'secondary-button')}</div><div class="section-title"><h2>答案与解释</h2><span class="small muted">点击题目展开</span></div>${result.answers.map((item, i) => answerReviewMarkup(questions.get(item.questionId), item.optionId, item.correct, i)).join('')}</div>`;
  }
  if (!session) return empty('还没有完成的练习', '从今天的学习任务开始吧。', button('go-home', '回到今天'));
  const entries = state.history.filter((item) => item.sessionId === session.id);
  const correct = entries.filter((item) => item.correct).length;
  return `<div class="session-shell"><section class="result-header"><span class="eyebrow">TODAY'S SMALL STEP</span><div class="score-ring" data-testid="result-score">${correct}<small>/ ${entries.length}</small></div><h1>这一小步，完成了。</h1><p class="muted">这次答了${entries.length}题。${correct === entries.length ? '保持耐心，隔一会儿再回忆。' : '答错的内容已安排复习，慢慢弄明白就好。'}</p><div class="row" style="justify-content:center">${button('go-home', '回到今天')}${button('go-report', '查看记录', 'secondary-button')}</div></section>${masteryNotices()}<h2>回看这次练习</h2>${entries.map((entry, i) => answerReviewMarkup(questions.get(entry.questionId), entry.optionId, entry.correct, i)).join('')}</div>`;
}

function renderReport() {
  const summary = summarize(DATA, state);
  const trend = (summary.daily || []).slice(-7);
  const peak = Math.max(1, ...trend.map((entry) => entry.answers));
  return `<div class="heading-row"><div><span class="eyebrow">THE LITTLE STEPS ADD UP</span><h1>看看走了多远</h1><p>看真实的作答记录，也留意还没检验过的方向。</p></div>${button('settings', '家长设置', 'secondary-button')}</div>${!hasLearningRecords({ state, ...recordCounts(state) }) ? storageHelpMarkup() : ''}<div class="stats-strip"><div class="stat"><strong>${summary.learned}</strong><span>已接触知识</span></div><div class="stat"><strong>${summary.basic}</strong><span>部分方向稳定</span></div><div class="stat"><strong>${summary.longTerm}</strong><span>进入长期间隔</span></div><div class="stat"><strong>${summary.mistakes}</strong><span>待巩固考点</span></div></div><div class="grid-3 report-categories">${Object.entries(CAT).map(([id, name]) => { const value = summary.categories[id]; return `<section class="panel"><h3>${name}<span>${value.learned}<small> / ${value.total}</small></span></h3><div class="progress-track"><span style="width:${value.learned / Math.max(1, value.total) * 100}%"></span></div><p class="small muted">已接触 ${value.learned} · 到期 ${value.due} · 待巩固 ${value.mistakes}</p></section>`; }).join('')}</div><div class="grid-2 spacer"><section class="panel"><div class="section-title" style="margin-top:0"><h2>最近7天的学习节奏</h2><span class="small muted">作答次数</span></div><div class="trend">${trend.map((entry) => `<div class="trend-day"><small>${entry.answers || ''}</small><div class="trend-bar" style="height:${Math.max(3, entry.answers / peak * 85)}px" title="${esc(entry.day)}：${entry.answers}次，答对${entry.correct}次"></div><span>${esc(entry.day.slice(5))}</span></div>`).join('')}</div><p class="small muted spacer">包含独立作答和短时重测，不把刷题次数当作掌握数量。</p></section><section class="panel"><h2>术语，一级一级接触</h2><p class="small muted">这里统计看过或练过的术语；双向掌握进度见下方。</p><div class="level-rows">${[1, 2, 3, 4, 5].map((n) => { const row = summary.levels[n] || { total: 0, learned: 0 }; return `<div class="level-row"><span>第 ${n} 级</span><div class="progress-track"><span style="width:${row.learned / Math.max(1, row.total) * 100}%"></span></div><small>${row.learned}/${row.total}</small></div>`; }).join('')}</div></section></div><div class="notice">上方“稳定”和“长期间隔”按全部已收录方向、属性和关系统计；下方“术语双向达标”只检验词与释义的两个方向，口径不同。一次答对不能算整级掌握。${button('wrong-practice', '练练待巩固考点 →', 'ghost-button')}</div><div class="grid-2 spacer"><section class="panel"><div class="section-title" style="margin-top:0"><h2>模拟练习记录</h2><span class="small muted">共 ${state.exams.length} 次</span></div>${state.exams.length ? `<ul class="history-list">${[...state.exams].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10).map((exam) => `<li><div><strong>${esc(prettyTime(exam.finishedAt))}</strong><br>${button('view-exam', '查看这份练习', 'ghost-button', `data-exam="${esc(exam.id)}"`)}</div><span class="score">${exam.score}<small>/10</small></span></li>`).join('')}</ul>` : '<p class="muted small">还没有模拟成绩。学过一些知识后，再试一份10题练习。</p>'}</section><section class="panel"><h2>最近练过的知识</h2>${state.history.length ? `<ul class="history-list">${[...state.history].reverse().slice(0, 8).map((entry) => { const question = questions.get(entry.questionId); const card = (entry.knowledgeIds || []).map((id) => cards.get(id)).find(Boolean); return `<li><div>${button('history-card', esc(card?.title || question?.prompt || '练习记录'), 'ghost-button', `data-card="${esc(card?.id || '')}"`)}<br><span class="small muted">${esc(prettyTime(entry.at))} · ${entry.independent ? '独立作答' : entry.mode === 'retry' ? '短时重测' : '辅助练习'}</span></div><span class="${entry.correct ? 'badge-correct' : 'badge-wrong'}">${entry.correct ? '✓' : '待巩固'}</span></li>`; }).join('')}</ul>` : '<p class="small muted">开始学习后，这里会留下每一小步。</p>'}</section></div>${termLevelsMarkup()}${masteryNotices()}${quizHistoryMarkup()}<p class="footer-note">${esc(uiStorageStatus().message || '记录只保存在当前设备')} · ${button('settings', '导出备份', 'ghost-button')}</p>`;
}

function quizHistoryMarkup() {
  return `<section class="panel spacer" data-testid="quiz-history"><div class="section-title" style="margin-top:0"><h2>按范围测验记录</h2><span class="small muted">共 ${state.quizzes.length} 次</span></div>${state.quizzes.length ? `<ul class="history-list">${[...state.quizzes].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10).map((quiz) => `<li><div><strong>${esc(prettyTime(quiz.finishedAt))}</strong><p class="small muted">${esc(scopeLabel(quiz.scope))}</p>${button('view-quiz', '查看这份测验', 'ghost-button', `data-quiz="${esc(quiz.id)}"`)}</div><span class="score">${quiz.score}<small>/${quiz.total}</small></span></li>`).join('')}</ul>` : '<p class="small muted">还没有按范围测验记录。选择等级和语言后，可以做一份小测验。</p>'}</section>`;
}

function openDialog(title, body) {
  $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2>${button('close-dialog', icon('close'), 'icon-button', 'aria-label="关闭窗口"')}</div><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}

function downloadRecord(content, filename) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function storageHelpMarkup() {
  return `<div class="notice row storage-help"><p><strong>以前的记录没有显示？</strong><br>先检查这个浏览器里仍保留的副本，也可以导出当前页面的记录。</p>${button('storage-inspect', '检查本机记录', 'secondary-button', 'data-testid="storage-inspect"')}</div>`;
}

function recordCounts(value) {
  return { historyCount: value?.history?.length || 0, skillsCount: Object.keys(value?.skills || {}).length,
    learnedCount: Object.keys(value?.learned || {}).length, examCount: value?.exams?.length || 0,
    quizCount: value?.quizzes?.length || 0 };
}

function hasLearningRecords(source) {
  return ['historyCount', 'skillsCount', 'learnedCount', 'examCount', 'quizCount'].some((key) => source[key] > 0) || Boolean(source.state?.activeSession);
}

function storageSourceMarkup(source, index) {
  const available = source.status === 'available';
  const statusText = { available: '已读到副本', missing: '未找到副本', invalid: '原内容格式异常', error: '暂时无法读取' }[source.status] || '读取状态未知';
  const counts = available ? `<p class="storage-counts" data-testid="storage-source-counts">作答 ${source.historyCount || 0} 条 · 已接触 ${source.learnedCount || 0} 个知识 · 复习 ${source.skillsCount || 0} 项<br>模拟 ${source.examCount || 0} 次 · 按范围测验 ${source.quizCount || 0} 次${source.state?.activeSession && !source.state.activeSession.completed ? ' · 有未完成练习' : ''}</p>` : '';
  const savedAt = source.id === 'current-page' ? '这是检查时的页面内容，不代表已保存到本机。' : source.savedAt > 0 ? `副本保存时间：${new Date(source.savedAt).toLocaleString('zh-CN')}` : available ? '副本没有可用的保存时间。' : '';
  const hasRaw = source.raw !== undefined && source.raw !== null;
  const exportButton = available && source.state ? button('storage-export-source', '导出这份记录', 'secondary-button', `data-source-index="${index}" data-source-id="${esc(source.id)}" data-testid="storage-export-source"`) : hasRaw ? button('storage-export-source', '导出原始内容', 'secondary-button', `data-source-index="${index}" data-source-id="${esc(source.id)}" data-testid="storage-export-source"`) : '';
  return `<section class="storage-source" data-testid="storage-source" data-source-id="${esc(source.id)}" data-source-status="${esc(source.status)}"><div class="storage-source-heading"><h3>${esc(source.label)}</h3><span class="small muted">${esc(statusText)}</span></div>${counts}${savedAt ? `<p class="small muted">${esc(savedAt)}</p>` : ''}${source.error ? `<p class="small storage-read-error">${esc(source.error)}</p>` : ''}${!available && hasRaw ? '<p class="small muted">原始内容可下载留存，尚不能当作有效备份导入。</p>' : ''}${exportButton}</section>`;
}

async function showStoredProgress() {
  stopPlayback();
  currentDialogCard = null;
  inspectedSources = [];
  const current = state ? structuredClone(state) : loadSnapshot ? structuredClone(loadSnapshot) : null;
  openDialog('检查本机记录', '<p class="small muted" role="status">正在只读检查本机副本，不会覆盖学习记录……</p>');
  let inspection;
  try { inspection = await inspectStoredProgress(); }
  catch (error) { inspection = { sources: [{ id: 'inspection-error', label: '本机存储', status: 'error', error: error.message || '本次检查未完成。' }], checkedAt: Date.now() }; }
  const currentSource = current ? { id: 'current-page', label: '当前页面', status: 'available', state: current, ...recordCounts(current) } : { id: 'current-page', label: '当前页面', status: 'missing' };
  inspectedSources = [currentSource, ...inspection.sources];
  const uncertain = inspectedSources.some((source) => ['invalid', 'error'].includes(source.status));
  const hasRecords = inspectedSources.some(hasLearningRecords);
  const summary = hasRecords ? '本次读到了含学习记录的副本。请按条数和保存时间分别导出，保留后再核对。' : uncertain ? '有副本尚未能可靠读取，暂时不能判断旧记录是否还在。请保留原浏览器数据和可导出的原始内容。' : '此浏览器入口未找到可恢复副本。这次检查不能判断其他浏览器入口或你以前导出的文件是否仍有记录。';
  const storage = uiStorageStatus();
  openDialog('检查本机记录', `<p class="small muted">检查只读取当前浏览器，不会自动恢复、合并或覆盖，也不会上传记录。下方导出的是本次检查读到的副本。</p><p class="notice ${uncertain || !hasRecords ? 'warm' : ''}" data-testid="storage-inspection-summary">${esc(summary)}</p>${storage.reason === 'conflict' || storage.reason === 'read-uncertain' ? `<p class="small storage-read-error">${esc(storage.message)} 先导出需要保留的各份记录，再重新打开原网址读取最新记录。</p>` : ''}<div class="storage-sources" data-testid="storage-diagnostics">${inspectedSources.map(storageSourceMarkup).join('')}</div><p class="small muted spacer">历史副本从 V1.1.1 开始在本机有限保留；不能补出此前已被覆盖或清除的记录。若另一个旧页面仍显示记录，请先在那个页面导出。</p><p class="small muted">要使用某份记录，请先保留当前页面的备份，再通过“导入记录”选择文件并确认替换。导入不会绕过存储冲突保护。</p><div class="dialog-actions">${button('storage-inspect', '重新检查', 'secondary-button', 'data-testid="storage-recheck"')}${button('import-progress', '导入记录', 'secondary-button')}${button('close-dialog', '完成检查', 'primary-button')}</div>`);
}

function showSettings() {
  stopPlayback();
  currentDialogCard = null;
  const storage = uiStorageStatus();
  openDialog('家长设置与备份', `<p class="muted small">一个孩子，一本练习册。记录保存在当前浏览器里，换设备前请导出备份。</p><section class="settings-section"><h3>我的学习安排</h3><p class="small muted">${state.settings.studyMode === 'scoped' ? '按范围安排' : '自动安排'} · ${esc(scopeLabel(getStudyScope(state)))}</p>${button('edit-study-scope', '选择学习范围', 'secondary-button')}</section><section class="settings-section"><h3>每天的节奏</h3><div class="field"><label for="daily-new">每天最多学习几个新知识</label><select id="daily-new">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${state.settings.dailyNew === n ? 'selected' : ''}>${n ? `${n} 个` : '只复习，暂不学新内容'}</option>`).join('')}</select><span class="small muted">到期复习较多时会减少新内容，不为凑数量提前复习。</span></div><div class="field"><label for="default-exam-minutes">默认模拟练习时长</label><select id="default-exam-minutes">${[0, 5, 10, 15, 20].map((n) => `<option value="${n}" ${Number(state.settings.examMinutes) === n ? 'selected' : ''}>${n ? `${n} 分钟` : '不设时限'}</option>`).join('')}</select></div>${button('save-settings', '保存设置', 'primary-button')}</section><section class="settings-section"><h3>给学习记录留一份备份</h3><p class="small muted">手机与电脑各自保存进度，不自动云同步。导入会替换这台设备的记录；请先导出留存。</p><div class="row">${button('export-progress', `${icon('download')} 导出记录`, 'secondary-button', 'data-testid="export-progress"')}${button('import-progress', '导入记录', 'secondary-button', 'data-testid="import-progress"')}</div><div class="row spacer">${button('storage-inspect', '检查本机记录', 'secondary-button', 'data-testid="storage-inspect"')}</div><p class="small muted spacer"><span class="status-dot"></span>${esc(storage.message)}${storage.persisted ? ' · 已获得持久保存权限' : ''}</p>${button('persist-storage', '尽量保留本机记录', 'ghost-button')}<p class="small muted">即使浏览器允许持久保存，仍建议定期导出；清理网站数据会删除本机记录。</p></section><section class="settings-section"><h3>放到手机桌面</h3><p class="small muted">更新无需卸载或清理网站数据。</p><p class="small muted">${esc(pwaStatus.message || '首次打开时正在准备离线资源。')}</p>${button('install-app', '添加到桌面', 'secondary-button')}${pwaStatus.updateAvailable && !state.activeSession?.completed && state.activeSession ? '<p class="small muted">有新版可用，请先完成当前练习，再更新。</p>' : pwaStatus.updateAvailable ? button('update-app', '更新应用', 'secondary-button') : ''}</section><section class="settings-section"><h3>关于这本练习册</h3><p class="small muted">包含 ${DATA.cards.length} 个知识点和 ${DATA.questions.length} 道原创题。家庭训练内容经过AI核对，尚无人工内容验收或真实提分验证；程序运行不调用AI。模拟练习按已核对用途选题，不是官方原卷。</p><p class="small muted">教材知识是答案依据；标准释义后的教辅括注保留作对照。部分知识页小图可能是孩子见过的素材。</p>${button('official-examples', '查看4条官方参考例题', 'ghost-button')}<p class="small muted">应用版本：V1.1.1 · 题库版本：${esc(DATA.version)}</p></section><section class="settings-section"><h3>重新开始</h3><p class="small muted">清空会删除当前浏览器中的学习记录及本机历史副本，不影响题库。建议先导出。</p>${button('clear-progress', '清空本机学习记录', 'danger-button', 'data-testid="clear-progress"')}</section>`);
}

function showHistory(cardId) {
  stopPlayback();
  const card = cards.get(cardId);
  if (!card) return;
  currentDialogCard = null;
  const history = state.history.filter((entry) => entry.knowledgeIds.includes(cardId));
  openDialog(`${card.title} · 学习历史`, `<p class="small muted">只记录实际做过的考查方向；不能从一次答对推断全部属性已掌握。</p>${history.length ? `<ul class="history-list">${[...history].reverse().map((entry) => `<li><div><strong>${esc(prettyTime(entry.at))}</strong><p class="small muted">${esc(questions.get(entry.questionId)?.prompt || entry.questionId)}<br>${entry.independent ? '独立间隔作答' : entry.mode === 'retry' ? '短时重测，不升级阶段' : '辅助练习'} · 阶段 ${entry.stageAfter || 0}</p></div><span class="${entry.correct ? 'badge-correct' : 'badge-wrong'}">${entry.correct ? '答对' : '待巩固'}</span></li>`).join('')}</ul>` : '<p>还没有作答记录。</p>'}${button('open-card', '查看知识卡', 'primary-button', `data-card="${esc(cardId)}"`)}`);
}

async function startSession(ids, mode, kinds = {}, minutes = 0, scope = null) {
  if (!ids.length) { toast(mode === 'daily' ? '现在没有到期任务，可以先看看知识卡。' : '当前条件下没有可练习的题目，请换个范围。'); return; }
  if (state.activeSession && !state.activeSession.completed && !confirm('还有一份未完成的练习。开始新练习会替换它，已完成的作答记录保留。确定继续吗？')) return;
  const now = Date.now();
  const questionIds = ids.map((item) => typeof item === 'string' ? item : item.id || item.questionId).filter((id) => questions.has(id));
  if (!questionIds.length) { toast('这组题暂时不可用。'); return; }
  state.activeSession = {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `session-${now}-${Math.random().toString(36).slice(2)}`,
    mode, questionIds, index: 0, answers: {}, optionOrders: Object.fromEntries(questionIds.map((id) => [id, shuffleOptions(questions.get(id)).map((option) => option.id)])),
    startedAt: now, deadline: minutes ? now + minutes * 60000 : null,
    kinds, studied: {}, flagged: {}, feedback: null, completed: false,
    ...(scope ? { scope: normalizeScope(scope) } : {}),
  };
  lastResult = null;
  await persist();
  if (dialog.open) dialog.close();
  navigate('session');
}

async function submitExam(automatic = false) {
  const session = state.activeSession;
  if (!session || !isAssessment(session) || session.completed) return;
  const unanswered = session.questionIds.filter((id) => !session.answers[id]).length;
  if (!automatic && !confirm(unanswered ? `还有 ${unanswered} 题未作答，将按未得分处理。确定交卷吗？` : '确认交卷并查看答案吗？')) return;
  const finish = session.mode === 'quiz' ? finishScopeQuiz : finishExam;
  const completed = finish(state, session.questionIds.map((id) => questions.get(id)), session.answers, { now: Date.now(), startedAt: session.startedAt, sessionId: session.id, ...(session.mode === 'quiz' ? { scope: session.scope } : {}) });
  state = completed.state;
  state.activeSession = { ...session, completed: true };
  lastResult = completed.result;
  await persist();
  if (dialog.open) dialog.close();
  navigate('result');
  if (automatic) toast('练习时间到了，已自动交卷。');
}

function updateTimer() {
  const session = state?.activeSession;
  if (!session || !isAssessment(session) || session.completed || !session.deadline) return;
  const seconds = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
  const timer = $('#exam-timer');
  if (timer) { timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; timer.classList.toggle('urgent', seconds < 60); }
  if (!seconds && !timerSubmitting && !busy) {
    timerSubmitting = true;
    submitExam(true).catch((error) => toast(`交卷未完成：${error.message}`)).finally(() => { timerSubmitting = false; });
  }
}

async function handleAction(target) {
  const action = target.dataset.action;
  const session = state?.activeSession;
  const qid = session?.questionIds[session.index];
  const question = questions.get(qid);
  switch (action) {
    case 'go-home': navigate('home'); break;
    case 'go-audio': if (dialog.open) dialog.close(); currentDialogCard = null; navigate('audio'); break;
    case 'go-exam': navigate('exam'); break;
    case 'go-quiz': {
      quizScope = target.dataset.usePractice ? readScope('practice', practiceCategory) : getStudyScope(state);
      navigate('quiz'); break;
    }
    case 'go-report': navigate('report'); break;
    case 'study-mode-auto': {
      state.settings.studyMode = 'auto';
      const saved = await persist(); resetPracticeScope(); quizScope = null;
      toast(saved.durable ? '已切换为自动安排，使用全部学习记录。' : '本页已切换，尚未保存到本机。'); render(); break;
    }
    case 'study-mode-scoped':
    case 'edit-study-scope': showStudyScope(); break;
    case 'save-study-scope': {
      state.settings.studyScope = readScope('study');
      state.settings.studyMode = 'scoped';
      const saved = await persist(); resetPracticeScope(); quizScope = null; dialog.close();
      toast(saved.durable ? `已按所选范围安排${session && !session.completed ? '下一组' : '这组'}学习；范围已保存。` : '范围仅在本页生效，尚未保存到本机。'); navigate('home'); break;
    }
    case 'use-knowledge-scope': {
      state.settings.studyScope = normalizeScope({ category, levelMode: level === 'all' ? 'all' : 'exact', level: level === 'all' ? 1 : Number(level), languages: language === 'all' ? Object.keys(LANG) : [language] });
      state.settings.studyMode = 'scoped';
      const saved = await persist(); resetPracticeScope(); quizScope = null;
      toast(saved.durable ? '已将类别、级别和语言设为学习范围。' : '范围仅在本页生效，尚未保存到本机。'); navigate('home'); break;
    }
    case 'next-level': {
      const nextLevel = Number(target.dataset.level);
      if (!Number.isInteger(nextLevel) || nextLevel < 2 || nextLevel > 5) break;
      state.settings.studyScope = normalizeScope({ category: 'terms', levelMode: 'exact', level: nextLevel, languages: Object.keys(LANG) });
      state.settings.studyMode = 'scoped';
      const saved = await persist(); resetPracticeScope(); quizScope = null;
      toast(saved.durable ? `已选择第 ${nextLevel} 级；之前的术语仍会到期复习。` : '本页已选择下一级，尚未保存到本机。'); navigate('home'); break;
    }
    case 'settings': showSettings(); break;
    case 'close-dialog': stopPlayback(); currentDialogCard = null; dialog.close(); break;
    case 'resume': navigate(state.activeSession?.completed ? 'result' : 'session'); break;
    case 'pause-session': await persist(); navigate(session?.mode === 'quiz' ? 'quiz' : session?.mode === 'exam' ? 'exam' : 'home'); break;
    case 'start-daily': {
      const plan = buildDailyPlan(DATA, state);
      if (!plan.items.length) { navigate('report'); break; }
      await startSession(plan.items.map((item) => item.questionId), 'daily', Object.fromEntries(plan.items.map((item) => [item.questionId, item.kind])), 0, plan.scope); break;
    }
    case 'review-all-due': {
      const plan = buildDailyPlan(DATA, state, Date.now(), { mode: 'auto', reviewOnly: true });
      await startSession(plan.items.map((item) => item.questionId), 'daily', Object.fromEntries(plan.items.map((item) => [item.questionId, item.kind])), 0, plan.scope); break;
    }
    case 'browse-category': category = target.dataset.category; search = ''; level = language = 'all'; visibleCards = 24; navigate('learn'); break;
    case 'filter-category': category = target.dataset.category; visibleCards = 24; render(); break;
    case 'more-cards': visibleCards += 24; render(); break;
    case 'open-card': showCard(target.dataset.card); break;
    case 'reveal-card': revealed.add(target.dataset.card); if (dialog.open) showCard(target.dataset.card); else render(); break;
    case 'mark-learned': { state = markLearned(state, target.dataset.card, Date.now()); const saved = await persist(); toast(saved.durable ? '记下了，之后用作答来检验是否记住。' : '本页记下了，但未能保存；离开前请导出备份。'); if (dialog.open) dialog.close(); render(); break; }
    case 'begin-recall': {
      stopPlayback();
      if (!session || !question) break;
      state = markLearned(state, target.dataset.card, Date.now());
      state.activeSession.studied[qid] = true;
      await persist(); render(); break;
    }
    case 'practice-card': {
      const card = cards.get(target.dataset.card);
      if (!card) break;
      const scope = normalizeScope({ category: card.category, levelMode: card.level ? 'exact' : 'all', level: card.level || 1, languages: card.language ? [card.language] : Object.keys(LANG) });
      const matching = DATA.questions.filter((item) => item.knowledgeIds.includes(card.id) && item.role !== 'hold' && questionMatchesScope(DATA, item, scope)).map((item) => item.id);
      await startSession(matching.slice(0, 5), 'practice', {}, 0, scope); break;
    }
    case 'retry-voices': detectVoices(); break;
    case 'speak': {
      const card = cards.get(target.dataset.card);
      if (card) {
        const sample = recordingsByCard.get(card.id);
        if (sample) playSample(card, sample, Number(target.dataset.rate));
        else speakCard(card, Number(target.dataset.rate));
      }
      break;
    }
    case 'practice-category': practiceScope = readScope('practice', practiceCategory); practiceCategory = target.dataset.category; render(); break;
    case 'reset-practice-scope': resetPracticeScope(); render(); break;
    case 'reset-quiz-scope': quizScope = getStudyScope(state); render(); break;
    case 'wrong-practice': practiceMode = 'mistakes'; resetPracticeScope(); practiceDirection = 'all'; navigate('practice'); break;
    case 'start-practice': {
      practiceScope = readScope('practice', practiceCategory);
      await startSession(selectPractice(DATA, state, { category: practiceCategory, direction: practiceDirection, count: practiceCount, mode: practiceMode, scope: practiceScope }), 'practice', {}, 0, practiceScope); break;
    }
    case 'start-quiz': {
      quizScope = readScope('quiz'); quizCount = Number($('#quiz-count').value); quizMinutes = Number($('#quiz-minutes').value);
      await startSession(buildScopeQuiz(DATA, state, { scope: quizScope, count: quizCount }), 'quiz', {}, quizMinutes, quizScope); break;
    }
    case 'start-exam': state.settings.examMinutes = Number($('#exam-minutes').value); await startSession(buildExam(DATA, state), 'exam', {}, state.settings.examMinutes); break;
    case 'choose-option': {
      if (!session || !question || session.completed || (!isAssessment(session) && session.feedback?.questionId === qid)) break;
      if (!question.options.some((option) => option.id === target.dataset.option)) break;
      session.answers[qid] = target.dataset.option; await persist(); render(); break;
    }
    case 'submit-answer': {
      if (!session || !question || isAssessment(session) || session.feedback?.questionId === qid || !session.answers[qid]) break;
      const selected = session.answers[qid];
      state = recordAnswer(state, question, selected, { now: Date.now(), mode: session.kinds?.[qid] || 'practice', sessionId: session.id });
      state.activeSession.feedback = { questionId: qid, correct: selected === question.answerId };
      await persist(); render(); break;
    }
    case 'next-question': {
      if (!session || session.completed || (!isAssessment(session) && session.feedback?.questionId !== qid)) break;
      if (session.index < session.questionIds.length - 1) { session.index++; session.feedback = null; await persist(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
      else if (!isAssessment(session)) { session.completed = true; await persist(); navigate('result'); }
      break;
    }
    case 'previous-question': if (isAssessment(session) && session.index > 0) { session.index--; await persist(); render(); } break;
    case 'jump-question': if (isAssessment(session)) { const index = Number(target.dataset.index); if (Number.isInteger(index) && index >= 0 && index < session.questionIds.length) { session.index = index; await persist(); render(); } } break;
    case 'flag-question': if (isAssessment(session)) { session.flagged[qid] = !session.flagged[qid]; await persist(); render(); } break;
    case 'submit-exam': await submitExam(); break;
    case 'history-card': showHistory(target.dataset.card); break;
    case 'view-exam': lastResult = state.exams.find((item) => item.id === target.dataset.exam); navigate('result'); break;
    case 'view-quiz': lastResult = state.quizzes.find((item) => item.id === target.dataset.quiz); navigate('result'); break;
    case 'save-settings': { state.settings.dailyNew = Number($('#daily-new').value); state.settings.examMinutes = Number($('#default-exam-minutes').value); const saved = await persist(); toast(saved.durable ? '设置已保存到本机。' : '设置仅在本页生效，尚未写入本机；下次打开可能仍是旧设置。'); dialog.close(); render(); break; }
    case 'export-progress': {
      downloadRecord(exportProgress(state), `learning-backup-${dayKey()}.json`);
      toast('备份文件已生成，请妥善保存。'); break;
    }
    case 'storage-inspect': await showStoredProgress(); break;
    case 'storage-export-source': {
      const source = inspectedSources[Number(target.dataset.sourceIndex)];
      if (!source) throw new Error('这份检查结果已失效，请重新检查本机记录。');
      const name = source.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      if (source.status === 'available' && source.state) {
        downloadRecord(exportProgress(source.state), `learning-backup-${name}-${dayKey()}.json`);
        toast('所选副本的备份文件已生成。请保留文件，再核对或导入。');
      } else if (source.raw !== undefined && source.raw !== null) {
        downloadRecord(source.raw, `learning-original-${name}-${dayKey()}.json`);
        toast('原始内容已导出留存，尚不能当作有效备份导入。');
      } else throw new Error('这份副本没有可导出的内容，请重新检查。');
      break;
    }
    case 'import-progress': $('#import-file').value = ''; $('#import-file').click(); break;
    case 'persist-storage': { const granted = await requestPersistence(); syncStorageBanner(); toast(granted === true || granted?.persisted ? '浏览器已允许尽量保留记录，仍建议定期备份。' : '浏览器暂未授予持久保存，请定期导出。'); showSettings(); break; }
    case 'install-app': {
      if (deferredInstall) { await deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; }
      else openDialog('添加到手机桌面', `<p>iPhone 或 iPad：使用 Safari 打开网址，点击“分享”，选择“添加到主屏幕”。</p><p>Android：在浏览器菜单中查找“安装应用”或“添加到主屏幕”。</p><p class="notice small">${esc(pwaStatus.message || '离线功能需要浏览器支持，并先成功加载资源。')}</p><p class="small muted">只有完成添加才会出现在桌面；不同浏览器的菜单名称可能不同。</p>`);
      break;
    }
    case 'update-app': if (!session || session.completed) window.dispatchEvent(new Event('pwa-apply-update')); else toast('请先完成当前练习，再更新。'); break;
    case 'official-examples': currentDialogCard = null; openDialog('官方参考例题', `<p class="small muted">以下4条为少量有出处的官方节选，仅作参考。它们不混入原创模拟练习，也不代表整套官方题库。</p>${(DATA.officialExamples || []).map((item, i) => `<details class="review-answer"><summary>${i + 1}. ${esc(item.prompt)}</summary><div class="answer-body">${item.promptTranslation ? `<p class="small muted">项目译文：${esc(item.promptTranslation)}</p>` : ''}${stimulusMarkup(item)}<ul>${item.options.map((option) => `<li>${esc(option.text)}</li>`).join('')}</ul><p><strong>答案：${esc(item.options.find((option) => option.id === item.answerId)?.text || '')}</strong></p><p>${esc(item.explanation)}</p>${sourcesMarkup(item.sources)}</div></details>`).join('')}`); break;
    case 'clear-progress': if (confirm('清空这台设备的全部学习记录和本机历史副本？题库会保留。此操作不能撤销，请确认已经导出需要保留的记录。')) { state = createState(DATA.version); lastResult = null; resetPracticeScope(); quizScope = null; const saved = await persist({ clearBackups: true }); dialog.close(); toast(saved.durable ? '本机记录及历史副本已清空。' : saved.message || '清空未完成，请检查本机记录。'); navigate('home'); } break;
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  if (!state && !['storage-inspect', 'storage-export-source', 'close-dialog', 'import-progress'].includes(target.dataset.action)) return;
  if (busy) return;
  busy = true;
  try { await handleAction(target); }
  catch (error) { console.error(error); toast(error.message || '这一步没有完成，请再试一次。'); }
  finally { busy = false; }
});

document.addEventListener('change', (event) => {
  switch (event.target.id) {
    case 'knowledge-level': level = event.target.value; visibleCards = 24; render(); break;
    case 'knowledge-language': language = event.target.value; visibleCards = 24; render(); break;
    case 'practice-direction': practiceDirection = event.target.value; break;
    case 'practice-count': practiceCount = Number(event.target.value); break;
    case 'mistakes-only': practiceMode = event.target.checked ? 'mistakes' : 'practice'; break;
    case 'quiz-count': quizCount = Number(event.target.value); break;
    case 'quiz-minutes': quizMinutes = Number(event.target.value); break;
  }
  const prefix = event.target.closest('[data-scope-editor]')?.dataset.scopeEditor ||
    (['practice-direction', 'practice-count', 'mistakes-only'].includes(event.target.id) ? 'practice' :
      ['quiz-count', 'quiz-minutes'].includes(event.target.id) ? 'quiz' : null);
  if (prefix) updateScopePreview(prefix);
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('文件超过20MB，请选择有效的学习记录备份。');
    const imported = validateImport(JSON.parse(await file.text()), DATA);
    if (!confirm(`即将用备份中的 ${imported.history.length} 条作答、${imported.exams.length} 次模拟、${imported.quizzes.length} 次按范围测验记录替换本机记录。是否继续？`)) return;
    state = imported; lastResult = null; resetPracticeScope(); quizScope = null; const saved = await persist();
    if (dialog.open) dialog.close();
    toast(saved.durable ? '记录已导入并保存到本机。' : '备份已在本页打开，尚未写入本机；下次打开可能仍是旧记录。请保留备份文件。'); navigate(state.activeSession && !state.activeSession.completed ? 'session' : 'report');
  } catch (error) { toast(`没有导入：${error.message}`); }
});

let searchTimer;
document.addEventListener('input', (event) => {
  if (event.target.id !== 'knowledge-search') return;
  search = event.target.value; visibleCards = 24;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (route !== 'learn') return;
    const position = $('#knowledge-search')?.selectionStart;
    render();
    const input = $('#knowledge-search'); input?.focus();
    if (input && position != null) { try { input.setSelectionRange(position, position); } catch {} }
  }, 220);
});

window.addEventListener('hashchange', () => { stopPlayback(); route = location.hash.slice(1) || 'home'; render(); });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event; });
window.addEventListener('pwa-status', (event) => {
  pwaStatus = event.detail;
  // A cache notification must not replace the controls a learner is using.
  const status = $('#home-offline-status');
  if (status) status.textContent = offlineStatusText();
});
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('已添加到设备，请从桌面图标打开试试。'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateTimer(); });
if (speechSupported()) window.speechSynthesis.addEventListener('voiceschanged', () => refreshVoices());
detectVoices();
dialog.addEventListener('close', () => { currentDialogCard = null; stopPlayback(); });
window.addEventListener('pagehide', stopPlayback);
dialog.addEventListener('click', (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });

try {
  loadSnapshot = await loadState(DATA.version);
  state = updateLevelMilestones(DATA, normalizeStudyState(validateImport(loadSnapshot, DATA)));
  if (!state || state.schemaVersion !== 1) throw new Error('学习记录格式不支持，请先导出已有备份后处理。');
  route = location.hash.slice(1) || (state.activeSession && !state.activeSession.completed ? 'session' : 'home');
  render();
} catch (error) {
  console.error(error);
  main.innerHTML = empty('练习本暂时没有打开', error.message || '请先检查并导出本机记录；如果正在离线，联网后再打开。', `<div class="row" style="justify-content:center">${button('storage-inspect', '检查本机记录', 'secondary-button', 'data-testid="storage-inspect"')}<button type="button" id="recovery-export" class="secondary-button">先导出当前记录</button><button type="button" id="recovery-import" class="primary-button">导入有效备份</button></div>`) + '<p class="footer-note">已有本机记录未被覆盖。导出文件可能需要修复，请妥善保留。</p>';
  $('#recovery-export').addEventListener('click', () => {
    downloadRecord(loadSnapshot, `learning-backup-recovery-${dayKey()}.json`);
  });
  $('#recovery-import').addEventListener('click', () => { $('#import-file').value = ''; $('#import-file').click(); });
}

setInterval(updateTimer, 1000);
// Read-only readiness counts; never exposes learning records or answer state.
window.appDiagnostics = () => ({ ready: Boolean(state), appVersion: '1.1.1', version: DATA.version, cards: DATA.cards.length, questions: DATA.questions.length, candidates: DATA.questions.filter((item) => item.section6Candidate).length, storage: uiStorageStatus().mode, screen: route, activeSession: Boolean(state?.activeSession && !state.activeSession.completed), noRuntimeAI: true });
