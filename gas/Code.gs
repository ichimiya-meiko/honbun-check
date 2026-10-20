/**
 * 本文分析ノート（honbun-check） GAS バックエンド
 * v1（フェーズ1）
 *
 * ・すべて doPost で JSON を受け取り、action で分ける。
 * ・答え（pos / alt / chunks / role / ok / why / example）は講師用の操作でしか返さない。
 * ・採点はここで行い、生徒には「どこが ✗ か」だけを返す。
 * ・書き込みは LockService で順番待ちにする。提出は submissionId で重複を除く。
 */

const VERSION = 1;
const TZ = 'Asia/Tokyo';

const SHEETS = {
  Lessons: ['lessonId', 'grade', 'textbook', 'unit', 'part', 'title', 'json', 'updatedAt'],
  Students: ['studentId', 'name', 'grade', 'pin', 'active'],
  Teachers: ['teacherId', 'name', 'active'],
  Assignments: ['assignmentId', 'lessonId', 'studentId', 'dueDate', 'createdAt'],
  Drafts: ['studentId', 'lessonId', 'answersJson', 'updatedAt'],
  Submissions: ['submissionId', 'studentId', 'lessonId', 'attempt', 'answersJson', 'rate', 'catScoresJson', 'qCount', 'submittedAt', 'checkedBy', 'checkedAt'],
  Settings: ['key', 'value']
};

const POS_KEYS = ['名', '代', '動', '助', '形', '副', '前', '接', '冠'];
const ROLES = ['S', 'V', 'O', 'C', '修飾', 'つなぎ'];

/* ===== 入口 ===== */

function doGet() {
  return out({ status: 'ok', app: 'honbun-check', version: VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ status: 'error', message: '送られたデータが読めませんでした。' });
  }
  try {
    return out(route(req));
  } catch (err) {
    if (err && err.userMessage) return out({ status: 'error', code: err.code || '', message: err.userMessage });
    console.error(err && err.stack ? err.stack : err);
    return out({ status: 'error', message: 'サーバーでエラーが起きました。少し待ってからもう一度ためしてください。' });
  }
}

const ACTIONS = {
  ping: { open: true, fn: () => ({ version: VERSION }) },
  login: { fn: login },
  listAssignments: { fn: listAssignments },
  getLessonForStudent: { fn: getLessonForStudent },
  saveDraft: { fn: saveDraft },
  submit: { fn: submit },
  listLessons: { teacher: true, fn: listLessons },
  listSubmissions: { teacher: true, fn: listSubmissions },
  check: { teacher: true, fn: check },
  uncheck: { teacher: true, fn: uncheck }
};

function route(req) {
  const a = ACTIONS[req && req.action];
  if (!a) throw userError('知らない操作です。');
  if (!a.open) checkSetting('classCode', req.classCode, 'class', '教室コードがちがいます。');
  if (a.teacher) checkSetting('teacherPass', req.teacherPass, 'teacher', '講師用の合言葉がちがいます。');
  return Object.assign({ status: 'ok' }, a.fn(req));
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userError(msg, code) {
  const e = new Error(msg);
  e.userMessage = msg;
  e.code = code || '';
  return e;
}

function checkSetting(key, given, code, msg) {
  const want = getSetting(key);
  if (!want) throw userError(`Settings シートに ${key} が入っていません。`, code);
  if (String(given || '').trim() !== want) {
    Utilities.sleep(400); // 総当たりを遅くする
    throw userError(msg, code);
  }
}

/* ===== シートの読み書き ===== */

function sheet(name) {
  const s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw userError(`「${name}」シートがありません。setup を実行してください。`);
  return s;
}

function cell(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy/MM/dd HH:mm:ss');
  if (v === null || v === undefined) return '';
  return String(v);
}

/** シートを {見出し: 値} の配列で読む。_row は行番号。 */
function rows(name) {
  const v = sheet(name).getDataRange().getValues();
  if (!v.length) return [];
  const head = v[0].map(h => String(h).trim());
  const list = [];
  for (let i = 1; i < v.length; i++) {
    const o = { _row: i + 1 };
    let any = false;
    head.forEach((h, j) => {
      if (!h) return;
      o[h] = cell(v[i][j]);
      if (o[h] !== '') any = true;
    });
    if (any) list.push(o);
  }
  return list;
}

function header(s) {
  return s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(h => String(h).trim());
}

/** 1行を書く。文字は「書式なしテキスト」にして、日付や数字への自動変換を防ぐ。 */
function writeRow(s, row, head, obj) {
  const vals = head.map(h => (obj[h] === undefined || obj[h] === null ? '' : obj[h]));
  const fm = vals.map(v => (typeof v === 'string' ? '@' : 'General'));
  s.getRange(row, 1, 1, head.length).setNumberFormats([fm]).setValues([vals]);
}

function appendObj(name, obj) {
  const s = sheet(name);
  writeRow(s, s.getLastRow() + 1, header(s), obj);
}

function updateObj(name, rowObj, changes) {
  const s = sheet(name);
  const head = header(s);
  const merged = {};
  head.forEach(h => { merged[h] = rowObj[h] === undefined ? '' : rowObj[h]; });
  Object.assign(merged, changes);
  writeRow(s, rowObj._row, head, merged);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw userError('いま混み合っています。少し待ってからもう一度ためしてください。');
  try {
    const r = fn();
    SpreadsheetApp.flush();
    return r;
  } finally {
    lock.releaseLock();
  }
}

function stamp() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss');
}

function getSetting(key) {
  const r = rows('Settings').find(x => x.key.trim() === key);
  return r ? r.value.trim() : '';
}

function isActive(v) {
  return !/^(false|0|no|いいえ|×|x)$/i.test(String(v).trim());
}

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

/* ===== 生徒・講師・レッスン ===== */

function activeStudents() {
  return rows('Students').filter(s => s.studentId.trim() && isActive(s.active))
    .map(s => ({ studentId: s.studentId.trim(), name: s.name, grade: s.grade.trim() }));
}

function findStudent(id) {
  const st = activeStudents().find(s => s.studentId === String(id || '').trim());
  if (!st) throw userError('生徒が見つかりません。もう一度ログインしてください。', 'student');
  return st;
}

function activeTeachers() {
  return rows('Teachers').filter(t => t.name.trim() && isActive(t.active)).map(t => t.name.trim());
}

function loadLesson(lessonId) {
  const id = String(lessonId || '').trim();
  const r = rows('Lessons').find(x => x.lessonId.trim() === id);
  if (!r) throw userError('このレッスンが見つかりません。');
  const L = parseJson(r.json, null);
  if (!L || !Array.isArray(L.sentences)) throw userError(`レッスン ${id} の json が正しくありません。`);
  L.lessonId = id;
  L.title = L.title || r.title || id;
  L.grade = L.grade || r.grade.trim();
  L.note = L.note || [r.textbook, r.unit, r.part].filter(Boolean).join(' ');
  L.words = Array.isArray(L.words) ? L.words : [];
  L.sentences.forEach(s => {
    s.tokens = Array.isArray(s.tokens) ? s.tokens : [];
    s.chunks = Array.isArray(s.chunks) ? s.chunks : [];
    s.end = s.end || '';
  });
  return L;
}

/** 生徒に送る形。答え（pos / alt / chunks / ok / why / example）を削る。 */
function publicLesson(L) {
  return {
    lessonId: L.lessonId, title: L.title, note: L.note || '', grade: L.grade || '',
    sentences: L.sentences.map(s => ({
      tokens: s.tokens.map(t => (t.glue ? { w: t.w, glue: true } : { w: t.w })),
      end: s.end
    })),
    words: L.words.map(w => ({ w: w.w, sentence: w.sentence }))
  };
}

/** その生徒に配られたレッスン。Assignments に1行もなければ同じ学年のレッスン全部。 */
function lessonsForStudent(st) {
  const lessons = rows('Lessons').filter(r => r.lessonId.trim());
  const asg = rows('Assignments').filter(a => a.studentId.trim() === st.studentId);
  if (asg.length) {
    return asg.map(a => {
      const l = lessons.find(r => r.lessonId.trim() === a.lessonId.trim());
      return l ? { row: l, dueDate: a.dueDate } : null;
    }).filter(Boolean);
  }
  return lessons.filter(r => r.grade.trim() === st.grade).map(r => ({ row: r, dueDate: '' }));
}

function assertAssigned(st, lessonId) {
  if (!lessonsForStudent(st).some(x => x.row.lessonId.trim() === String(lessonId).trim())) {
    throw userError('このレッスンはまだ配られていません。');
  }
}

/** その講師画面に出す生徒。Assignments にあればその生徒、なければ同じ学年の生徒。 */
function studentsForLesson(L) {
  const all = activeStudents();
  const ids = rows('Assignments').filter(a => a.lessonId.trim() === L.lessonId).map(a => a.studentId.trim());
  if (ids.length) return all.filter(s => ids.indexOf(s.studentId) >= 0);
  return all.filter(s => s.grade === L.grade);
}

function submissionsOf(studentId, lessonId) {
  return rows('Submissions').filter(r => r.studentId.trim() === studentId && r.lessonId.trim() === lessonId)
    .sort((a, b) => Number(a.attempt) - Number(b.attempt));
}

/* ===== 採点 ===== */

function chunksFrom(bounds, n) {
  const b = bounds.slice().sort((x, y) => x - y).filter((x, i, arr) => arr.indexOf(x) === i);
  const outList = [];
  let st = 0;
  b.forEach(g => { if (g >= st && g < n - 1) { outList.push([st, g]); st = g + 1; } });
  outList.push([st, n - 1]);
  return outList;
}

function posOk(tk, v) {
  return !!v && (v === tk.pos || (tk.alt || []).indexOf(v) >= 0);
}

/** 送られてきた答えを、レッスンの形に合わせて整える（変な値は捨てる）。 */
function normalize(L, a) {
  a = a && typeof a === 'object' ? a : {};
  const res = { meanings: {}, bounds: [], roles: [], pos: [], q: {}, memo: '' };
  const m = a.meanings || {};
  L.words.forEach(w => { if (typeof m[w.w] === 'string') res.meanings[w.w] = m[w.w].slice(0, 200); });
  L.sentences.forEach((s, si) => {
    const n = s.tokens.length;
    const b = (a.bounds || [])[si];
    res.bounds[si] = Array.isArray(b) ? b.filter(g => Number.isInteger(g) && g >= 0 && g < n - 1) : [];
    const r = (a.roles || [])[si] || {};
    res.roles[si] = {};
    Object.keys(r).forEach(k => { if (/^\d+-\d+$/.test(k) && ROLES.indexOf(r[k]) >= 0) res.roles[si][k] = r[k]; });
    const p = (a.pos || [])[si] || [];
    res.pos[si] = s.tokens.map((_, ti) => (POS_KEYS.indexOf(p[ti]) >= 0 ? p[ti] : null));
  });
  const q = a.q || {};
  Object.keys(q).forEach(k => {
    const mm = /^(\d+)-(\d+)$/.exec(k);
    if (q[k] && mm && L.sentences[+mm[1]] && +mm[2] < L.sentences[+mm[1]].tokens.length) res.q[k] = 1;
  });
  res.memo = String(a.memo || '').slice(0, 1000);
  return res;
}

function grade(L, a) {
  const items = [];
  L.sentences.forEach((s, si) => {
    s.tokens.forEach((tk, ti) => items.push({ cat: '品詞', ok: posOk(tk, a.pos[si][ti]) }));
    const ch = chunksFrom(a.bounds[si], s.tokens.length);
    s.chunks.forEach(c => {
      const has = ch.some(x => x[0] === c.from && x[1] === c.to);
      items.push({ cat: 'かたまり', ok: has && a.roles[si][c.from + '-' + c.to] === c.role });
    });
  });
  L.words.forEach(w => {
    const v = (a.meanings[w.w] || '').trim();
    items.push({ cat: '意味', w: w.w, ok: !!v && (w.ok || []).some(k => v.indexOf(k) >= 0) });
  });
  const by = c => { const f = items.filter(i => i.cat === c); return { n: f.length, hit: f.filter(i => i.ok).length }; };
  const hit = items.filter(i => i.ok).length;
  return {
    items,
    rate: items.length ? Math.round(hit / items.length * 100) : 0,
    cats: { 意味: by('意味'), かたまり: by('かたまり'), 品詞: by('品詞') }
  };
}

/** 生徒に返す結果。正解は入れず、生徒の答えのどこが ○ / ✗ かだけ。 */
function studentResult(L, a) {
  const g = grade(L, a);
  const tok = L.sentences.map((s, si) => s.tokens.map((tk, ti) => posOk(tk, a.pos[si][ti])));
  const grp = L.sentences.map((s, si) => {
    const o = {};
    chunksFrom(a.bounds[si], s.tokens.length).forEach(c => {
      const k = c[0] + '-' + c[1];
      const kc = s.chunks.find(x => x.from === c[0] && x.to === c[1]);
      o[k] = !!kc && kc.role === (a.roles[si][k] || '');
    });
    return o;
  });
  const mean = {};
  g.items.filter(i => i.cat === '意味').forEach(i => { mean[i.w] = i.ok; });
  return { rate: g.rate, cats: g.cats, marks: { tok, grp, mean } };
}

/* ===== 操作：共通 ===== */

function login() {
  return { version: VERSION, students: activeStudents(), teachers: activeTeachers() };
}

/* ===== 操作：生徒 ===== */

function listAssignments(req) {
  const st = findStudent(req.studentId);
  const subs = rows('Submissions').filter(r => r.studentId.trim() === st.studentId);
  const drafts = rows('Drafts').filter(r => r.studentId.trim() === st.studentId);
  const lessons = lessonsForStudent(st).map(({ row, dueDate }) => {
    const id = row.lessonId.trim();
    const mine = subs.filter(r => r.lessonId.trim() === id).sort((a, b) => Number(a.attempt) - Number(b.attempt));
    const last = mine[mine.length - 1];
    return {
      lessonId: id,
      title: row.title || id,
      note: [row.textbook, row.unit, row.part].filter(Boolean).join(' '),
      dueDate: dueDate,
      hasDraft: drafts.some(d => d.lessonId.trim() === id),
      attempts: last ? Number(last.attempt) : 0,
      rate: last ? Number(last.rate) : null,
      checked: last ? !!last.checkedAt : false
    };
  });
  return { lessons };
}

function getLessonForStudent(req) {
  const st = findStudent(req.studentId);
  assertAssigned(st, req.lessonId);
  const L = loadLesson(req.lessonId);
  const d = rows('Drafts').find(r => r.studentId.trim() === st.studentId && r.lessonId.trim() === L.lessonId);
  const subs = submissionsOf(st.studentId, L.lessonId);
  const last = subs[subs.length - 1];
  let latest = null;
  if (last) {
    const ans = normalize(L, parseJson(last.answersJson, {}));
    latest = { attempt: Number(last.attempt), submittedAt: last.submittedAt, answers: ans, result: studentResult(L, ans) };
  }
  return {
    lesson: publicLesson(L),
    draft: d ? normalize(L, parseJson(d.answersJson, {})) : null,
    draftUpdatedAt: d ? d.updatedAt : '',
    latest
  };
}

function upsertDraft(studentId, lessonId, answers) {
  const d = rows('Drafts').find(r => r.studentId.trim() === studentId && r.lessonId.trim() === lessonId);
  const obj = { studentId, lessonId, answersJson: JSON.stringify(answers), updatedAt: stamp() };
  if (d) updateObj('Drafts', d, obj);
  else appendObj('Drafts', obj);
  return obj.updatedAt;
}

function saveDraft(req) {
  const st = findStudent(req.studentId);
  assertAssigned(st, req.lessonId);
  const L = loadLesson(req.lessonId);
  const a = normalize(L, req.answers);
  const savedAt = withLock(() => upsertDraft(st.studentId, L.lessonId, a));
  return { savedAt };
}

function submit(req) {
  const st = findStudent(req.studentId);
  assertAssigned(st, req.lessonId);
  const id = String(req.submissionId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw userError('提出の番号が正しくありません。');
  const L = loadLesson(req.lessonId);
  return withLock(() => {
    const dup = rows('Submissions').find(r => r.submissionId === id);
    if (dup) {
      // 同じ提出が2回届いたときは、1回目の結果をそのまま返す
      const ans = normalize(L, parseJson(dup.answersJson, {}));
      return Object.assign({ submissionId: id, attempt: Number(dup.attempt), submittedAt: dup.submittedAt, answers: ans, duplicate: true }, studentResult(L, ans));
    }
    const a = normalize(L, req.answers);
    const res = studentResult(L, a);
    const attempt = submissionsOf(st.studentId, L.lessonId).length + 1;
    const submittedAt = stamp();
    appendObj('Submissions', {
      submissionId: id, studentId: st.studentId, lessonId: L.lessonId, attempt,
      answersJson: JSON.stringify(a), rate: res.rate, catScoresJson: JSON.stringify(res.cats),
      qCount: Object.keys(a.q).length, submittedAt, checkedBy: '', checkedAt: ''
    });
    upsertDraft(st.studentId, L.lessonId, a);
    return Object.assign({ submissionId: id, attempt, submittedAt, answers: a }, res);
  });
}

/* ===== 操作：講師（合言葉が必要） ===== */

function listLessons() {
  const lessons = rows('Lessons').filter(r => r.lessonId.trim()).map(r => ({
    lessonId: r.lessonId.trim(), grade: r.grade.trim(), title: r.title || r.lessonId.trim(),
    note: [r.textbook, r.unit, r.part].filter(Boolean).join(' ')
  }));
  return { lessons, teachers: activeTeachers() };
}

function listSubmissions(req) {
  const L = loadLesson(req.lessonId);
  const subs = rows('Submissions').filter(r => r.lessonId.trim() === L.lessonId);
  const drafts = rows('Drafts').filter(r => r.lessonId.trim() === L.lessonId);
  const students = studentsForLesson(L).map(s => {
    const mine = subs.filter(r => r.studentId.trim() === s.studentId).sort((a, b) => Number(a.attempt) - Number(b.attempt));
    const last = mine[mine.length - 1];
    const d = drafts.find(r => r.studentId.trim() === s.studentId);
    return Object.assign({}, s, {
      latest: last ? {
        submissionId: last.submissionId, attempt: Number(last.attempt), submittedAt: last.submittedAt,
        answers: normalize(L, parseJson(last.answersJson, {})), checkedBy: last.checkedBy, checkedAt: last.checkedAt
      } : null,
      draft: d ? normalize(L, parseJson(d.answersJson, {})) : null
    });
  });
  return { lesson: L, students, loadedAt: stamp() };
}

function setCheck(req, on) {
  const id = String(req.submissionId || '');
  let name = '';
  if (on) {
    name = String(req.teacherName || '').trim();
    if (activeTeachers().indexOf(name) < 0) throw userError('講師の名前が見つかりません。');
  }
  return withLock(() => {
    const r = rows('Submissions').find(x => x.submissionId === id);
    if (!r) throw userError('この提出が見つかりません。画面を最新にしてください。');
    const checkedAt = on ? stamp() : '';
    updateObj('Submissions', r, { checkedBy: name, checkedAt });
    return { submissionId: id, checkedBy: name, checkedAt };
  });
}

function check(req) { return setCheck(req, true); }
function uncheck(req) { return setCheck(req, false); }

/* ===== 最初に1回だけ実行する：シートの準備 ===== */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    let s = ss.getSheetByName(name);
    if (!s) s = ss.insertSheet(name);
    if (s.getLastRow() === 0) {
      const head = SHEETS[name];
      s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      s.setFrozenRows(1);
      s.getRange(2, 1, s.getMaxRows() - 1, head.length).setNumberFormat('@');
    }
  });
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  if (rows('Settings').length === 0) {
    appendObj('Settings', { key: 'classCode', value: 'kyoshitsu-test' });
    appendObj('Settings', { key: 'teacherPass', value: 'sensei-test' });
  }
  if (rows('Students').length === 0) {
    [['T01', 'テスト 生徒A'], ['T02', 'テスト 生徒B'], ['T03', 'テスト 生徒C']].forEach(([id, name]) =>
      appendObj('Students', { studentId: id, name, grade: '中1', pin: '', active: 'TRUE' }));
  }
  if (rows('Teachers').length === 0) {
    appendObj('Teachers', { teacherId: 'K01', name: 'テスト先生', active: 'TRUE' });
  }
  if (!rows('Lessons').some(r => r.lessonId.trim() === TEST_LESSON.lessonId)) {
    appendObj('Lessons', {
      lessonId: TEST_LESSON.lessonId, grade: TEST_LESSON.grade, textbook: 'テスト用（自作の英文）', unit: '', part: '',
      title: TEST_LESSON.title, json: JSON.stringify(TEST_LESSON), updatedAt: stamp()
    });
  }
  console.log('準備ができました。Settings シートの classCode と teacherPass を書きかえてください。');
}

/* テスト用レッスン。教科書ではない自作の英文。 */
const TEST_LESSON = {
  lessonId: 'TEST-1',
  grade: '中1',
  title: 'テスト用　ぼくの犬',
  sentences: [
    {
      tokens: [{ w: 'I', pos: '代' }, { w: 'have', pos: '動' }, { w: 'a', pos: '冠' }, { w: 'dog', pos: '名' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'S' }, { from: 1, to: 1, role: 'V' }, { from: 2, to: 3, role: 'O', why: '「1ぴきの犬を」。have の「何を？」にあたるので O。' }]
    },
    {
      tokens: [{ w: 'His', pos: '代', why: '「彼の」。he の所有格。name の前に付く。' }, { w: 'name', pos: '名' }, { w: 'is', pos: '動' }, { w: 'Pochi', pos: '名' }],
      end: '.',
      chunks: [{ from: 0, to: 1, role: 'S', why: 'His name で「彼の名前は」。2語で1つの主語。' }, { from: 2, to: 2, role: 'V' }, { from: 3, to: 3, role: 'C', why: 'His name = Pochi。イコールなので C。' }]
    },
    {
      tokens: [{ w: 'He', pos: '代' }, { w: "'s", pos: '動', glue: true, why: "'s は is の短縮形。be動詞。" }, { w: 'very', pos: '副', why: 'cute をくわしくする「とても」。形容詞をくわしくするのは副詞。' }, { w: 'cute', pos: '形' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'S' }, { from: 1, to: 1, role: 'V' }, { from: 2, to: 3, role: 'C', why: 'He = とてもかわいい。very cute で1つのかたまり。' }]
    },
    {
      tokens: [{ w: 'He', pos: '代' }, { w: 'likes', pos: '動' }, { w: 'dog', pos: '形', alt: ['名'], why: 'food をくわしくする「犬の」。名詞が名詞をくわしくしていると考えて名詞でも正解。' }, { w: 'food', pos: '名' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'S' }, { from: 1, to: 1, role: 'V' }, { from: 2, to: 3, role: 'O', why: 'likes の「何が好き？」にあたる。dog food で1つのかたまり。' }]
    },
    {
      tokens: [{ w: 'I', pos: '代' }, { w: 'walk', pos: '動' }, { w: 'with', pos: '前' }, { w: 'him', pos: '代', why: '「彼を・彼に」。he の目的格。前置詞のあとなので him。' }, { w: 'in', pos: '前' }, { w: 'the', pos: '冠' }, { w: 'park', pos: '名' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'S' }, { from: 1, to: 1, role: 'V' }, { from: 2, to: 3, role: '修飾', why: 'with him で「彼と一緒に」。前置詞から名詞（代名詞）までで1つの修飾。' }, { from: 4, to: 6, role: '修飾', why: 'in the park で「公園で」。場所を表す修飾。' }]
    },
    {
      tokens: [{ w: 'But', pos: '接' }, { w: 'he', pos: '代' }, { w: 'runs', pos: '動' }, { w: 'fast', pos: '副', why: 'runs をくわしくする「速く」。動詞をくわしくするのは副詞。' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'つなぎ', why: 'But は前の文とつなぐ語。' }, { from: 1, to: 1, role: 'S' }, { from: 2, to: 2, role: 'V' }, { from: 3, to: 3, role: '修飾', why: '「速く」は走り方をくわしくする。なくても文は成り立つ。' }]
    },
    {
      tokens: [{ w: 'We', pos: '代' }, { w: 'are', pos: '動' }, { w: 'good', pos: '形' }, { w: 'friends', pos: '名' }],
      end: '.',
      chunks: [{ from: 0, to: 0, role: 'S' }, { from: 1, to: 1, role: 'V' }, { from: 2, to: 3, role: 'C', why: 'We = よい友だち。イコールなので C。' }]
    }
  ],
  words: [
    { w: 'cute', sentence: 2, ok: ['かわい', '可愛'], example: 'かわいい' },
    { w: 'food', sentence: 3, ok: ['食べ物', 'たべもの', '食物', 'えさ', '餌', 'フード'], example: '食べ物' },
    { w: 'walk', sentence: 4, ok: ['散歩', 'さんぽ', '歩', 'ある'], example: '散歩する', why: 'ここでは「散歩する」。walk with him で「彼と散歩する」。' },
    { w: 'park', sentence: 4, ok: ['公園', 'こうえん'], example: '公園' },
    { w: 'fast', sentence: 5, ok: ['速', 'はや', '早'], example: '速く' },
    { w: 'friends', sentence: 6, ok: ['友', 'とも'], example: '友だち' }
  ]
};
