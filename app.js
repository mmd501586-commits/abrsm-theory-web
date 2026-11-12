import { DATA } from './data.js';
import { AUDIO_RECORDINGS, AUDIO_SAMPLES } from './audio-samples.js';
import {
  createState, dayKey, skillKey, buildDailyPlan, selectPractice, buildExam,
  shuffleOptions, recordAnswer, markLearned, summarize, finishExam,
  validateImport, exportProgress,
} from './core.js';
import { loadState, saveState, storageStatus, requestPersistence } from './storage.js';
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
let saveFailureMessage = null;
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
  return saveFailureMessage ? { ...status, mode: 'memory', durable: false, message: saveFailureMessage } : status;
}

function syncStorageBanner() {
  const status = uiStorageStatus();
  const banner = $('#storage-banner');
  banner.hidden = Boolean(status.durable);
  banner.textContent = status.durable ? '' : (status.message || '当前浏览器无法保存记录。本次可继续练习，离开前请在家长设置导出记录。');
}

async function persist() {
  let result;
  try {
    result = await saveState(state);
    saveFailureMessage = result?.durable ? null : '当前更改只在本页暂存，尚未写入本机。下次打开可能仍是旧记录；离开前请在家长设置导出备份。';
  } catch {
    saveFailureMessage = '当前更改只在本页暂存，尚未写入本机。下次打开可能仍是旧记录；离开前请在家长设置导出备份。';
  }
  syncStorageBanner();
  return result?.durable ? result : uiStorageStatus();
}

function navigate(next) {
  const valid = ['home', 'learn', 'practice', 'exam', 'report', 'session', 'result', 'audio'];
  stopPlayback();
  next = valid.includes(next) ? next : 'home';
  if (location.hash === `#${next}`) { route = next; render(); }
  else location.hash = next;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderNavigation() {
  let selected = route === 'audio' ? 'home' : route;
  if (['session', 'result'].includes(route)) selected = state.activeSession?.mode === 'exam' ? 'exam' : 'practice';
  $('#navigation').innerHTML = [['home', '今天'], ['learn', '知识'], ['practice', '练习'], ['exam', '模拟'], ['report', '记录']].map(([id, title]) => `<a href="#${id}" class="nav-button ${selected === id ? 'active' : ''}" data-testid="nav-${id}" ${selected === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${title}</span></a>`).join('');
}

function render() {
  if (!state) return;
  renderNavigation();
  syncStorageBanner();
  if (route === 'session' && !state.activeSession) route = 'home';
  if (route === 'session' && state.activeSession?.completed) route = 'result';
  const renderers = { home: renderHome, learn: renderLearn, practice: renderPractice, exam: renderExam, report: renderReport, session: renderSession, result: renderResult, audio: renderAudio };
  main.innerHTML = `<div class="page">${(renderers[route] || renderHome)()}</div>`;
  updateTimer();
}

function resumeBlock() {
  const session = state.activeSession;
  if (!session || session.completed) return '';
  const modeName = session.mode === 'exam' ? '模拟练习' : session.mode === 'daily' ? '今日任务' : '专项练习';
  return `<div class="notice row"><span>你有一份未完成的${modeName}，进度已保留。</span>${button('resume', `继续 · 第 ${Math.min(session.index + 1, session.questionIds.length)} 题`, 'ghost-button', 'data-testid="resume-session"')}</div>`;
}

function renderHome() {
  const summary = summarize(DATA, state);
  const plan = buildDailyPlan(DATA, state);
  const count = plan.items.length;
  return `<section class="hero"><div><span class="eyebrow">${esc(todayLabel())}</span><h1>每天一小步，<br>把音乐记牢。</h1><p>先想一想，再看答案。<br>用十来分钟，让熟悉的知识更稳一点。</p><div class="row">${button('start-daily', `${count ? `开始今日 ${count} 项任务` : '看看今天学了什么'} ${icon('arrow')}`, 'primary-button', 'data-testid="start-daily"')}<span class="pill white">建议 10–15 分钟</span></div></div><div class="hero-art" aria-hidden="true"><span class="orbit"></span><span class="orbit two"></span><div class="practice-book"><span class="book-tab"></span><small>MY MUSIC NOTEBOOK</small><strong>一小步<br>一音符</strong><div class="book-lines"></div></div></div></section>
    ${resumeBlock()}
    <div class="notice row audio-trial-banner"><p>已内置 ${recordingsByCard.size} 个术语读音，打开知识卡片即可听普通或慢速。</p><div class="row">${button('browse-category', `${icon('sound')} 去知识页听读音`, 'secondary-button', 'data-category="terms" data-testid="open-audio-terms"')}${button('go-audio', '试听3个读音样本', 'ghost-button', 'data-testid="open-audio-samples"')}</div></div>
    <div class="stats-strip"><div class="stat"><strong>${plan.dueCount || 0}</strong><span>到期复习</span></div><div class="stat"><strong>${plan.newCount || 0}</strong><span>今日新知识</span></div><div class="stat"><strong>${plan.retryCount || 0}</strong><span>短时重测</span></div><div class="stat"><strong>${summary.todayAnswers || 0}</strong><span>今天已作答</span></div></div>
    ${(plan.extensionCount || plan.remainingDueCount) ? `<p class="small muted">${plan.extensionCount ? `今天另有 ${plan.extensionCount} 项“换个角度”，练练熟悉知识的新方向。` : ''}${plan.remainingDueCount ? `本组完成后还有 ${plan.remainingDueCount} 项到期内容，可分批继续。` : ''}</p>` : ''}
    <div class="section-title"><h2>你的三本小练习册</h2><span class="eyebrow">LEARN · RECALL · REMEMBER</span></div>
    <div class="grid-3 topics-grid">${Object.entries(CAT).map(([id, name], i) => `<button type="button" class="topic-card" data-action="browse-category" data-category="${id}"><span class="topic-symbol">${['a tempo', '♬', '◖ ◗'][i]}</span><h3>${name}</h3><p>${['意 · 法 · 德，听懂谱面的提示', '看清记号，读懂怎样演奏', '家族、发声与高低音域'][i]}</p><span class="go">${icon('arrow')}</span></button>`).join('')}</div>
    <div class="grid-2 spacer"><section class="panel"><span class="eyebrow">YOUR PACE</span><h2>慢慢来，记得更牢</h2><p class="muted small">答错的内容会再次出现；还没到复习时间的知识，不用抢着刷。今天没有到期任务时，也可以自主学习。</p><div class="progress-track"><span style="width:${Math.min(100, (summary.learned || 0) / DATA.cards.length * 100)}%"></span></div><p class="small muted">已接触 ${summary.learned || 0} / ${DATA.cards.length} 个知识点</p></section><section class="panel"><span class="eyebrow">A LITTLE CHECK-IN</span><h2>试试第六部分</h2><p class="muted small">3项术语与标记、2项装饰音、5项乐器与人声。完成后再一起查看答案。</p>${button('go-exam', `进入模拟练习 ${icon('arrow')}`, 'ghost-button')}</section></div>
    <p class="footer-note">${uiStorageStatus().durable ? '学习记录保存在这台设备' : '本次记录只在本页暂存'} · ${pwaStatus.ready ? '离线资源已准备' : esc(pwaStatus.message || '首次使用请等待资源准备')}</p>`;
}

function renderLearn() {
  let filtered = DATA.cards.filter((card) => (category === 'all' || card.category === category) && (level === 'all' || Number(card.level) === Number(level)) && (language === 'all' || card.language === language));
  if (search.trim()) {
    const query = search.trim().toLocaleLowerCase();
    filtered = filtered.filter((card) => `${card.title} ${card.meaning} ${(card.facts || []).map((fact) => fact.value).join(' ')}`.toLocaleLowerCase().includes(query));
  }
  return `<div class="heading-row"><div><span class="eyebrow">KNOWLEDGE NOTEBOOK</span><h1>先认识，再记住</h1><p>翻开一张卡片，试着说出它的意思。</p></div><span class="pill">${DATA.cards.length} 个知识点</span></div>
    <div class="chip-row">${[['all', '全部'], ...Object.entries(CAT)].map(([id, title]) => `<button class="chip ${category === id ? 'selected' : ''}" data-action="filter-category" data-category="${id}" type="button">${title}</button>`).join('')}</div>
    <div class="filters"><div class="field search-field"><label for="knowledge-search">找一个知识点</label><input id="knowledge-search" data-testid="knowledge-search" type="search" placeholder="术语、中文意思或乐器名称" value="${esc(search)}"></div><div class="field"><label for="knowledge-level">教材级别</label><select id="knowledge-level"><option value="all">全部级别</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${level === String(n) ? 'selected' : ''}>第 ${n} 级</option>`).join('')}</select></div><div class="field"><label for="knowledge-language">术语语言</label><select id="knowledge-language"><option value="all">全部语言</option>${Object.entries(LANG).map(([id, text]) => `<option value="${id}" ${language === id ? 'selected' : ''}>${text}</option>`).join('')}</select></div></div>
    <p class="small muted">找到 ${filtered.length} 项 · 低级别知识也属于五级累计范围</p>
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
  return `<div class="heading-row"><div><span class="eyebrow">PRACTICE AT YOUR PACE</span><h1>一次，练明白一点</h1><p>答完一题就看解释，把不确定的地方弄清楚。</p></div></div>${resumeBlock()}<div class="setup-grid spacer"><section class="panel practice-setup"><h2>${practiceMode === 'mistakes' ? '回到容易出错的地方' : '选一本练习册'}</h2><div class="choice-group">${[['all', '混合练习'], ...Object.entries(CAT)].map(([id, title]) => `<button class="chip ${practiceCategory === id ? 'selected' : ''}" type="button" data-action="practice-category" data-category="${id}">${title}</button>`).join('')}</div><div class="field"><label for="practice-direction">术语考查方向</label><select id="practice-direction"><option value="all">两种方向都练</option><option value="term_to_meaning" ${practiceDirection === 'term_to_meaning' ? 'selected' : ''}>外文 → 中文意思</option><option value="meaning_to_term" ${practiceDirection === 'meaning_to_term' ? 'selected' : ''}>中文意思 → 外文</option></select><span class="small muted">方向只影响术语；其他板块按各自考点练习。</span></div><div class="field"><label for="practice-count">这次练几题</label><select id="practice-count">${[5, 10, 15, 20].map((n) => `<option value="${n}" ${practiceCount === n ? 'selected' : ''}>${n} 题</option>`).join('')}</select></div><label class="check-label"><input id="mistakes-only" type="checkbox" ${practiceMode === 'mistakes' ? 'checked' : ''}><span>只练尚需巩固的错题</span></label>${button('start-practice', `开始练习 ${icon('arrow')}`, 'primary-button full spacer', 'data-testid="start-practice"')}</section><aside class="side-note"><span class="eyebrow">A GOOD WAY TO LEARN</span><h3>别急着猜。</h3><div class="intro-step"><span>1</span><div><strong>先认真想一想</strong><p>选项位置会变化，要判断意思。</p></div></div><div class="intro-step"><span>2</span><div><strong>看懂为什么</strong><p>答错也没关系，解释会帮你找回知识。</p></div></div><div class="intro-step"><span>3</span><div><strong>隔一会儿再试</strong><p>短时重测和隔天复习，分别记录。</p></div></div><p class="small muted">专项练习包含辅助巩固题，和模拟练习的选题用途不同。</p></aside></div>`;
}

function renderExam() {
  const examCount = state.exams.length;
  return `<div class="heading-row"><div><span class="eyebrow">SECTION SIX · A LITTLE REHEARSAL</span><h1>第六部分，小小排练</h1><p>先独立完成，再一起检查。总共 10 分。</p></div><span class="pill">已完成 ${examCount} 次</span></div>${resumeBlock()}<div class="setup-grid spacer"><section class="exam-paper"><span class="eyebrow">YOUR PRACTICE PAPER</span><h2>今天的 10 个小挑战</h2>${[['01', '术语与标记', '3 题 · 3 分'], ['02', '看谱辨认装饰音', '2 题 · 2 分'], ['03', '乐器与人声判断', '5 题 · 5 分']].map(([n, title, count]) => `<div class="exam-layout-row"><div><span>${n}</span><h3>${title}</h3></div><strong>${count}</strong></div>`).join('')}<div class="field spacer"><label for="exam-minutes">练习计时</label><select id="exam-minutes">${[0, 5, 10, 15, 20].map((n) => `<option value="${n}" ${Number(state.settings.examMinutes) === n ? 'selected' : ''}>${n ? `${n} 分钟，到时自动交卷` : '不设时限'}</option>`).join('')}</select></div>${button('start-exam', `准备好了，开始 ${icon('arrow')}`, 'primary-button full spacer', 'data-testid="start-exam"')}</section><aside class="side-note"><h3>像考试一样，<br>认真读每一道题。</h3><ul><li>可以跳过暂时不确定的题，标记后再回来。</li><li>提交前不会提示对错；提交后显示分项得分和解释。</li><li>离开页面后可继续，设定的计时仍会走。</li></ul><p class="small muted">采用已核对题库的家庭模拟练习，参照官方样卷结构；题目可能重复，不等于官方原卷或全卷成绩预测。</p></aside></div>`;
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
  const isExam = session.mode === 'exam';
  const isNew = session.kinds?.[qid] === 'new' && !session.studied?.[qid];
  const studyCard = question.knowledgeIds.map((id) => cards.get(id)).find(Boolean);
  if (!isExam && isNew && studyCard) return `<div class="session-shell"><div class="session-top">${button('pause-session', `${icon('back')} ${isExam && session.deadline ? '离开（继续计时）' : '稍后继续'}`, 'ghost-button')}<span class="pill">先学，再试</span></div><section class="question-panel">${cardMarkup(studyCard, { study: true })}</section></div>`;
  const feedback = !isExam && session.feedback?.questionId === qid ? session.feedback : null;
  const answer = session.answers[qid];
  const order = session.optionOrders[qid] || question.options.map((item) => item.id);
  const options = order.map((id) => question.options.find((option) => option.id === id)).filter(Boolean);
  const letter = (i) => 'ABCD'[i] || String(i + 1);
  return `<div class="session-shell"><div class="session-top">${button('pause-session', `${icon('back')} ${isExam && session.deadline ? '离开（继续计时）' : '稍后继续'}`, 'ghost-button')}<span>${isExam ? '模拟练习' : session.mode === 'daily' ? '今日任务' : '专项练习'} · ${session.index + 1} / ${session.questionIds.length}</span>${isExam && session.deadline ? '<span class="timer" id="exam-timer" aria-label="剩余时间"></span>' : ''}</div><div class="session-progress" aria-hidden="true"><span style="width:${(session.index + 1) / session.questionIds.length * 100}%"></span></div><section class="question-panel"><div class="question-meta"><span class="eyebrow">${esc(CAT[question.category])} · ${session.kinds?.[qid] === 'extend' ? '换个角度 · ' : ''}${question.direction === 'meaning_to_term' ? '中文找外文' : question.direction === 'performed_notation_to_ornament' ? '看谱辨认' : '想一想，再作答'}</span>${isExam ? button('flag-question', session.flagged?.[qid] ? '已标记 · 再看一遍' : '标记这题', `flag-button ${session.flagged?.[qid] ? 'on' : ''}`, 'aria-pressed="' + Boolean(session.flagged?.[qid]) + '"') : ''}</div><h1 class="question-title" data-testid="question-prompt">${esc(question.prompt)}</h1>${stimulusMarkup(question)}<div class="option-list" role="group" aria-label="答案选项">${options.map((option, i) => `<button type="button" class="answer-option ${answer === option.id ? 'selected' : ''} ${feedback && option.id === question.answerId ? 'correct' : ''} ${feedback && answer === option.id && !feedback.correct ? 'incorrect' : ''}" data-action="choose-option" data-option="${esc(option.id)}" data-testid="question-option" data-option-id="${esc(option.id)}" aria-pressed="${answer === option.id}" ${feedback ? 'disabled' : ''}><span class="option-letter">${letter(i)}</span><span>${esc(option.text)}</span>${feedback && option.id === question.answerId ? '<span class="option-result">正确答案</span>' : ''}</button>`).join('')}</div>${feedback ? `<div class="feedback ${feedback.correct ? '' : 'wrong'}" data-testid="answer-feedback" role="status"><h3>${feedback.correct ? '答对了，记住这个区别。' : '这次先把它弄明白。'}</h3><p>${esc(question.explanation)}</p><p class="small">${feedback.correct ? (session.kinds?.[qid] === 'retry' ? '这是短时重测，不会提高长期记忆阶段。' : '结果已记入本题对应的考查方向。') : '约7分钟后可再测，明天还会安排复习。'}</p>${sourcesMarkup(question.sources)}</div>` : ''}<div class="session-actions">${isExam ? `${button('previous-question', '上一题', 'secondary-button', session.index === 0 ? 'disabled' : '')}${session.index < session.questionIds.length - 1 ? button('next-question', '下一题 →', 'primary-button', 'data-testid="next-question"') : button('submit-exam', '检查并交卷', 'primary-button', 'data-testid="submit-exam"')}` : feedback ? button('next-question', session.index === session.questionIds.length - 1 ? '完成这次练习' : '下一题 →', 'primary-button', 'data-testid="next-question"') : button('submit-answer', '确认答案', 'primary-button', `data-testid="submit-answer" ${answer ? '' : 'disabled'}`)}</div></section>${isExam ? `<div class="question-jump" aria-label="跳转题目">${session.questionIds.map((id, index) => `<button type="button" class="jump-button ${session.index === index ? 'current' : ''} ${session.answers[id] ? 'answered' : ''} ${session.flagged?.[id] ? 'flagged' : ''}" data-action="jump-question" data-index="${index}" aria-label="第${index + 1}题${session.answers[id] ? '，已作答' : '，未作答'}${session.flagged?.[id] ? '，已标记' : ''}">${index + 1}</button>`).join('')}</div><div class="row" style="justify-content:center">${button('submit-exam', '提前交卷', 'ghost-button', 'data-testid="submit-exam-early"')}<span class="small muted">● 表示已标记的题</span></div>` : ''}</div>`;
}

function answerReviewMarkup(question, selectedId, correct, index) {
  if (!question) return '';
  const correctText = question.options.find((option) => option.id === question.answerId)?.text || '';
  const selectedText = question.options.find((option) => option.id === selectedId)?.text || '未作答';
  return `<details class="review-answer" ${correct ? '' : 'open'}><summary><span class="${correct ? 'badge-correct' : 'badge-wrong'}">${correct ? '✓' : '○'}</span><span>${index + 1}. ${esc(question.prompt)}</span></summary><div class="answer-body">${stimulusMarkup(question)}<p>你的答案：${esc(selectedText)}</p>${!correct ? `<p><strong>正确答案：${esc(correctText)}</strong></p>` : ''}<p>${esc(question.explanation)}</p>${sourcesMarkup(question.sources)}<div class="row">${question.knowledgeIds.slice(0, 3).map((id) => cards.has(id) ? button('open-card', `再看 ${esc(cards.get(id).title)}`, 'text-button', `data-card="${esc(id)}"`) : '').join('')}</div></div></details>`;
}

function renderResult() {
  const session = state.activeSession;
  const result = lastResult || (session?.mode === 'exam' ? state.exams.find((item) => item.sessionId === session.id) : null);
  if (result) {
    const wrong = (result.answers || []).filter((item) => !item.correct);
    return `<div class="session-shell"><div class="result-header"><span class="eyebrow">A LITTLE PROGRESS</span><div class="score-ring" data-testid="result-score">${result.score}<small>/ 10</small></div><h1>${result.score >= 8 ? '完成了，继续稳稳地走。' : '找到要补上的地方，就是进步。'}</h1><p class="muted">${wrong.length ? `${wrong.length}道题需要再看一看，已加入对应复习记录。` : '这份练习全部答对了。隔些时间，再检验是否还记得。'}</p></div><div class="result-grid">${Object.entries(CAT).map(([id, name]) => `<div><strong>${result.sections[id]?.score || 0}<small> / ${result.sections[id]?.total || 0}</small></strong><span>${name}</span></div>`).join('')}</div><p class="notice small">这是本次第六部分模拟练习的结果，不代表全卷分数或未见题表现。</p><div class="row spacer">${button('go-home', '回到今天')}${button('go-report', '查看学习记录', 'secondary-button')}</div><div class="section-title"><h2>答案与解释</h2><span class="small muted">点击题目展开</span></div>${result.answers.map((item, i) => answerReviewMarkup(questions.get(item.questionId), item.optionId, item.correct, i)).join('')}</div>`;
  }
  if (!session) return empty('还没有完成的练习', '从今天的学习任务开始吧。', button('go-home', '回到今天'));
  const entries = state.history.filter((item) => item.sessionId === session.id);
  const correct = entries.filter((item) => item.correct).length;
  return `<div class="session-shell"><section class="result-header"><span class="eyebrow">TODAY'S SMALL STEP</span><div class="score-ring" data-testid="result-score">${correct}<small>/ ${entries.length}</small></div><h1>这一小步，完成了。</h1><p class="muted">这次答了${entries.length}题。${correct === entries.length ? '保持耐心，隔一会儿再回忆。' : '答错的内容已安排复习，慢慢弄明白就好。'}</p><div class="row" style="justify-content:center">${button('go-home', '回到今天')}${button('go-report', '查看记录', 'secondary-button')}</div></section><h2>回看这次练习</h2>${entries.map((entry, i) => answerReviewMarkup(questions.get(entry.questionId), entry.optionId, entry.correct, i)).join('')}</div>`;
}

function renderReport() {
  const summary = summarize(DATA, state);
  const trend = (summary.daily || []).slice(-7);
  const peak = Math.max(1, ...trend.map((entry) => entry.answers));
  return `<div class="heading-row"><div><span class="eyebrow">THE LITTLE STEPS ADD UP</span><h1>看看走了多远</h1><p>看真实的作答记录，也留意还没检验过的方向。</p></div>${button('settings', '家长设置', 'secondary-button')}</div><div class="stats-strip"><div class="stat"><strong>${summary.learned}</strong><span>已接触知识</span></div><div class="stat"><strong>${summary.basic}</strong><span>部分方向稳定</span></div><div class="stat"><strong>${summary.longTerm}</strong><span>进入长期间隔</span></div><div class="stat"><strong>${summary.mistakes}</strong><span>待巩固考点</span></div></div><div class="grid-3 report-categories">${Object.entries(CAT).map(([id, name]) => { const value = summary.categories[id]; return `<section class="panel"><h3>${name}<span>${value.learned}<small> / ${value.total}</small></span></h3><div class="progress-track"><span style="width:${value.learned / Math.max(1, value.total) * 100}%"></span></div><p class="small muted">已接触 ${value.learned} · 到期 ${value.due} · 待巩固 ${value.mistakes}</p></section>`; }).join('')}</div><div class="grid-2 spacer"><section class="panel"><div class="section-title" style="margin-top:0"><h2>最近7天的学习节奏</h2><span class="small muted">作答次数</span></div><div class="trend">${trend.map((entry) => `<div class="trend-day"><small>${entry.answers || ''}</small><div class="trend-bar" style="height:${Math.max(3, entry.answers / peak * 85)}px" title="${esc(entry.day)}：${entry.answers}次，答对${entry.correct}次"></div><span>${esc(entry.day.slice(5))}</span></div>`).join('')}</div><p class="small muted spacer">包含独立作答和短时重测，不把刷题次数当作掌握数量。</p></section><section class="panel"><h2>术语，一级一级巩固</h2><div class="level-rows">${[1, 2, 3, 4, 5].map((n) => { const row = summary.levels[n] || { total: 0, learned: 0 }; return `<div class="level-row"><span>第 ${n} 级</span><div class="progress-track"><span style="width:${row.learned / Math.max(1, row.total) * 100}%"></span></div><small>${row.learned}/${row.total}</small></div>`; }).join('')}</div></section></div><div class="notice">“稳定”和“长期间隔”只表示已练方向的证据，不等于整个知识点的全部属性都已掌握。${button('wrong-practice', '练练待巩固考点 →', 'ghost-button')}</div><div class="grid-2 spacer"><section class="panel"><div class="section-title" style="margin-top:0"><h2>模拟练习记录</h2><span class="small muted">共 ${state.exams.length} 次</span></div>${state.exams.length ? `<ul class="history-list">${[...state.exams].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10).map((exam) => `<li><div><strong>${esc(prettyTime(exam.finishedAt))}</strong><br>${button('view-exam', '查看这份练习', 'ghost-button', `data-exam="${esc(exam.id)}"`)}</div><span class="score">${exam.score}<small>/10</small></span></li>`).join('')}</ul>` : '<p class="muted small">还没有模拟成绩。学过一些知识后，再试一份10题练习。</p>'}</section><section class="panel"><h2>最近练过的知识</h2>${state.history.length ? `<ul class="history-list">${[...state.history].reverse().slice(0, 8).map((entry) => { const question = questions.get(entry.questionId); const card = (entry.knowledgeIds || []).map((id) => cards.get(id)).find(Boolean); return `<li><div>${button('history-card', esc(card?.title || question?.prompt || '练习记录'), 'ghost-button', `data-card="${esc(card?.id || '')}"`)}<br><span class="small muted">${esc(prettyTime(entry.at))} · ${entry.independent ? '独立作答' : entry.mode === 'retry' ? '短时重测' : '辅助练习'}</span></div><span class="${entry.correct ? 'badge-correct' : 'badge-wrong'}">${entry.correct ? '✓' : '待巩固'}</span></li>`; }).join('')}</ul>` : '<p class="small muted">开始学习后，这里会留下每一小步。</p>'}</section></div><p class="footer-note">${esc(uiStorageStatus().message || '记录只保存在当前设备')} · ${button('settings', '导出备份', 'ghost-button')}</p>`;
}

function openDialog(title, body) {
  $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2>${button('close-dialog', icon('close'), 'icon-button', 'aria-label="关闭窗口"')}</div><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}

function showSettings() {
  stopPlayback();
  currentDialogCard = null;
  const storage = uiStorageStatus();
  openDialog('家长设置与备份', `<p class="muted small">一个孩子，一本练习册。记录保存在当前浏览器里，换设备前请导出备份。</p><section class="settings-section"><h3>每天的节奏</h3><div class="field"><label for="daily-new">每天最多学习几个新知识</label><select id="daily-new">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${state.settings.dailyNew === n ? 'selected' : ''}>${n ? `${n} 个` : '只复习，暂不学新内容'}</option>`).join('')}</select><span class="small muted">到期复习较多时会减少新内容，不为凑数量提前复习。</span></div><div class="field"><label for="default-exam-minutes">默认模拟练习时长</label><select id="default-exam-minutes">${[0, 5, 10, 15, 20].map((n) => `<option value="${n}" ${Number(state.settings.examMinutes) === n ? 'selected' : ''}>${n ? `${n} 分钟` : '不设时限'}</option>`).join('')}</select></div>${button('save-settings', '保存设置', 'primary-button')}</section><section class="settings-section"><h3>给学习记录留一份备份</h3><p class="small muted">手机与电脑各自保存进度，不自动云同步。导入会替换这台设备的记录；请先导出留存。</p><div class="row">${button('export-progress', `${icon('download')} 导出记录`, 'secondary-button', 'data-testid="export-progress"')}${button('import-progress', '导入记录', 'secondary-button', 'data-testid="import-progress"')}</div><p class="small muted spacer"><span class="status-dot"></span>${esc(storage.message)}${storage.persisted ? ' · 已获得持久保存权限' : ''}</p>${button('persist-storage', '尽量保留本机记录', 'ghost-button')}<p class="small muted">即使浏览器允许持久保存，仍建议定期导出；清理网站数据会删除本机记录。</p></section><section class="settings-section"><h3>放到手机桌面</h3><p class="small muted">${esc(pwaStatus.message || '首次打开时正在准备离线资源。')}</p>${button('install-app', '添加到桌面', 'secondary-button')}${pwaStatus.updateAvailable && !state.activeSession?.completed && state.activeSession ? '<p class="small muted">有新版可用，请先完成当前练习，再更新。</p>' : pwaStatus.updateAvailable ? button('update-app', '更新应用', 'secondary-button') : ''}</section><section class="settings-section"><h3>关于这本练习册</h3><p class="small muted">包含 ${DATA.cards.length} 个知识点和 ${DATA.questions.length} 道原创题。家庭训练内容经过AI核对，尚无人工内容验收或真实提分验证；程序运行不调用AI。模拟练习按已核对用途选题，不是官方原卷。</p><p class="small muted">教材知识是答案依据；标准释义后的教辅括注保留作对照。部分知识页小图可能是孩子见过的素材。</p>${button('official-examples', '查看4条官方参考例题', 'ghost-button')}<p class="small muted">题库版本：${esc(DATA.version)}</p></section><section class="settings-section"><h3>重新开始</h3><p class="small muted">清空会删除当前浏览器中的学习记录，不影响题库。建议先导出。</p>${button('clear-progress', '清空本机学习记录', 'danger-button', 'data-testid="clear-progress"')}</section>`);
}

function showHistory(cardId) {
  stopPlayback();
  const card = cards.get(cardId);
  if (!card) return;
  currentDialogCard = null;
  const history = state.history.filter((entry) => entry.knowledgeIds.includes(cardId));
  openDialog(`${card.title} · 学习历史`, `<p class="small muted">只记录实际做过的考查方向；不能从一次答对推断全部属性已掌握。</p>${history.length ? `<ul class="history-list">${[...history].reverse().map((entry) => `<li><div><strong>${esc(prettyTime(entry.at))}</strong><p class="small muted">${esc(questions.get(entry.questionId)?.prompt || entry.questionId)}<br>${entry.independent ? '独立间隔作答' : entry.mode === 'retry' ? '短时重测，不升级阶段' : '辅助练习'} · 阶段 ${entry.stageAfter || 0}</p></div><span class="${entry.correct ? 'badge-correct' : 'badge-wrong'}">${entry.correct ? '答对' : '待巩固'}</span></li>`).join('')}</ul>` : '<p>还没有作答记录。</p>'}${button('open-card', '查看知识卡', 'primary-button', `data-card="${esc(cardId)}"`)}`);
}

async function startSession(ids, mode, kinds = {}, minutes = 0) {
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
  };
  lastResult = null;
  await persist();
  if (dialog.open) dialog.close();
  navigate('session');
}

async function submitExam(automatic = false) {
  const session = state.activeSession;
  if (!session || session.mode !== 'exam' || session.completed) return;
  const unanswered = session.questionIds.filter((id) => !session.answers[id]).length;
  if (!automatic && !confirm(unanswered ? `还有 ${unanswered} 题未作答，将按未得分处理。确定交卷吗？` : '确认交卷并查看答案吗？')) return;
  const completed = finishExam(state, session.questionIds.map((id) => questions.get(id)), session.answers, { now: Date.now(), startedAt: session.startedAt, sessionId: session.id });
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
  if (!session || session.mode !== 'exam' || session.completed || !session.deadline) return;
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
  const session = state.activeSession;
  const qid = session?.questionIds[session.index];
  const question = questions.get(qid);
  switch (action) {
    case 'go-home': navigate('home'); break;
    case 'go-audio': if (dialog.open) dialog.close(); currentDialogCard = null; navigate('audio'); break;
    case 'go-exam': navigate('exam'); break;
    case 'go-report': navigate('report'); break;
    case 'settings': showSettings(); break;
    case 'close-dialog': stopPlayback(); currentDialogCard = null; dialog.close(); break;
    case 'resume': navigate(state.activeSession?.completed ? 'result' : 'session'); break;
    case 'pause-session': await persist(); navigate(session?.mode === 'exam' ? 'exam' : 'home'); break;
    case 'start-daily': {
      const plan = buildDailyPlan(DATA, state);
      if (!plan.items.length) { navigate('report'); break; }
      await startSession(plan.items.map((item) => item.questionId), 'daily', Object.fromEntries(plan.items.map((item) => [item.questionId, item.kind]))); break;
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
      const matching = DATA.questions.filter((item) => item.knowledgeIds.includes(target.dataset.card) && item.role !== 'hold').map((item) => item.id);
      await startSession(matching.slice(0, 5), 'practice'); break;
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
    case 'practice-category': practiceCategory = target.dataset.category; render(); break;
    case 'wrong-practice': practiceMode = 'mistakes'; practiceCategory = 'all'; practiceDirection = 'all'; navigate('practice'); break;
    case 'start-practice': await startSession(selectPractice(DATA, state, { category: practiceCategory, direction: practiceDirection, count: practiceCount, mode: practiceMode }), 'practice'); break;
    case 'start-exam': state.settings.examMinutes = Number($('#exam-minutes').value); await startSession(buildExam(DATA, state), 'exam', {}, state.settings.examMinutes); break;
    case 'choose-option': {
      if (!session || !question || session.completed || (session.mode !== 'exam' && session.feedback?.questionId === qid)) break;
      if (!question.options.some((option) => option.id === target.dataset.option)) break;
      session.answers[qid] = target.dataset.option; await persist(); render(); break;
    }
    case 'submit-answer': {
      if (!session || !question || session.mode === 'exam' || session.feedback?.questionId === qid || !session.answers[qid]) break;
      const selected = session.answers[qid];
      state = recordAnswer(state, question, selected, { now: Date.now(), mode: session.kinds?.[qid] || 'practice', sessionId: session.id });
      state.activeSession.feedback = { questionId: qid, correct: selected === question.answerId };
      await persist(); render(); break;
    }
    case 'next-question': {
      if (!session || session.completed || (session.mode !== 'exam' && session.feedback?.questionId !== qid)) break;
      if (session.index < session.questionIds.length - 1) { session.index++; session.feedback = null; await persist(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
      else if (session.mode !== 'exam') { session.completed = true; await persist(); navigate('result'); }
      break;
    }
    case 'previous-question': if (session?.mode === 'exam' && session.index > 0) { session.index--; await persist(); render(); } break;
    case 'jump-question': if (session?.mode === 'exam') { const index = Number(target.dataset.index); if (Number.isInteger(index) && index >= 0 && index < session.questionIds.length) { session.index = index; await persist(); render(); } } break;
    case 'flag-question': if (session?.mode === 'exam') { session.flagged[qid] = !session.flagged[qid]; await persist(); render(); } break;
    case 'submit-exam': await submitExam(); break;
    case 'history-card': showHistory(target.dataset.card); break;
    case 'view-exam': lastResult = state.exams.find((item) => item.id === target.dataset.exam); navigate('result'); break;
    case 'save-settings': { state.settings.dailyNew = Number($('#daily-new').value); state.settings.examMinutes = Number($('#default-exam-minutes').value); const saved = await persist(); toast(saved.durable ? '设置已保存到本机。' : '设置仅在本页生效，尚未写入本机；下次打开可能仍是旧设置。'); dialog.close(); render(); break; }
    case 'export-progress': {
      const blob = new Blob([JSON.stringify(exportProgress(state), null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `learning-backup-${dayKey()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('备份文件已生成，请妥善保存。'); break;
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
    case 'clear-progress': if (confirm('清空这台设备的全部学习记录？题库会保留。此操作不能撤销，请确认已经导出需要保留的记录。')) { state = createState(DATA.version); lastResult = null; const saved = await persist(); dialog.close(); toast(saved.durable ? '本机记录已清空。' : '仅清空了当前页面，未能写入本机；下次打开可能仍会出现旧记录。'); navigate('home'); } break;
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || !state) return;
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
  }
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('文件超过20MB，请选择有效的学习记录备份。');
    const imported = validateImport(JSON.parse(await file.text()), DATA);
    if (!confirm(`即将用备份中的 ${imported.history.length} 条作答、${imported.exams.length} 次模拟记录替换本机记录。是否继续？`)) return;
    state = imported; lastResult = null; const saved = await persist();
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
window.addEventListener('pwa-status', (event) => { pwaStatus = event.detail; if (route === 'home') render(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('已添加到设备，请从桌面图标打开试试。'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateTimer(); });
if (speechSupported()) window.speechSynthesis.addEventListener('voiceschanged', () => refreshVoices());
detectVoices();
dialog.addEventListener('close', () => { currentDialogCard = null; stopPlayback(); });
window.addEventListener('pagehide', stopPlayback);
dialog.addEventListener('click', (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });

try {
  loadSnapshot = await loadState(DATA.version);
  state = validateImport(loadSnapshot, DATA);
  if (!state || state.schemaVersion !== 1) throw new Error('学习记录格式不支持，请先导出已有备份后处理。');
  route = location.hash.slice(1) || (state.activeSession && !state.activeSession.completed ? 'session' : 'home');
  render();
} catch (error) {
  console.error(error);
  main.innerHTML = empty('练习本暂时没有打开', error.message || '请刷新页面再试。如果正在离线，先联网完成首次加载。', '<div class="row" style="justify-content:center"><button type="button" id="recovery-export" class="secondary-button">先导出当前记录</button><button type="button" id="recovery-import" class="primary-button">导入有效备份</button></div>') + '<p class="footer-note">已有本机记录未被覆盖。导出文件可能需要修复，请妥善保留。</p>';
  $('#recovery-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(loadSnapshot, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `learning-backup-recovery-${dayKey()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#recovery-import').addEventListener('click', () => { $('#import-file').value = ''; $('#import-file').click(); });
}

setInterval(updateTimer, 1000);
// Read-only readiness counts; never exposes learning records or answer state.
window.appDiagnostics = () => ({ ready: Boolean(state), version: DATA.version, cards: DATA.cards.length, questions: DATA.questions.length, candidates: DATA.questions.filter((item) => item.section6Candidate).length, storage: uiStorageStatus().mode, screen: route, activeSession: Boolean(state?.activeSession && !state.activeSession.completed), noRuntimeAI: true });
