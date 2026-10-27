/**
 * 本文分析ノート（honbun-check） GAS バックエンド
 * v4（意味調べ：せりふ全部・日本語訳・単語の意味（lines）と挿絵。挿絵はドライブの非公開フォルダに置き、ログインした人にだけ返す）
 *
 * ・すべて doPost で JSON を受け取り、action で分ける。
 * ・答え（pos / alt / chunks / role / ok / why / example）は講師・教室長の操作でしか返さない。
 * ・採点はここで行い、生徒には「どこが ✗ か」だけを返す。
 * ・書き込みは LockService で順番待ちにする。提出は submissionId で重複を除く。
 * ・ログインすると「通行証（token）」を返す。生徒の PIN・講師と教室長のパスワードが合わない限り、データは返さない。
 * ・パスワードは Settings にハッシュ（SHA-256）で置く。平文で書かれていたら、次に使うときにハッシュにして平文を消す。
 */

const VERSION = 4;
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

const POS_KEYS = ['名', '代', '動', '助', '冠', '疑', '動名', '不', '形', '副', '前', '接', '間', 'その他'];
const ROLES = ['S', 'V', 'O', 'C', '修飾', 'その他'];
/* v2 までのレッスンで使っていた役割。新しいレッスンには使えないが、前のレッスンと提出は今までどおり採点する */
const OLD_ROLES = ['つなぎ'];
const ENDS = ['.', '!', '?'];

/* 通行証の有効期間（ミリ秒） */
const TOKEN_LIFE = { student: 180 * 864e5, teacher: 30 * 864e5, admin: 12 * 36e5 };
/* まちがいが続いたら、しばらくログインできなくする */
const FAIL_LIMIT = 5;
const FAIL_WAIT_SEC = 600;

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

/* role：その操作に必要な通行証。なし＝教室コードだけでよい */
const ACTIONS = {
  ping: { open: true, fn: () => ({ version: VERSION }) },
  listTeachers: { fn: () => ({ version: VERSION, teachers: activeTeachers() }) },
  login: { fn: login },
  listAssignments: { role: 'student', fn: listAssignments },
  getLessonForStudent: { role: 'student', fn: getLessonForStudent },
  saveDraft: { role: 'student', fn: saveDraft },
  submit: { role: 'student', fn: submit },
  listLessons: { role: 'teacher', fn: listLessons },
  listSubmissions: { role: 'teacher', fn: listSubmissions },
  check: { role: 'teacher', fn: check },
  uncheck: { role: 'teacher', fn: uncheck },
  adminData: { role: 'admin', fn: adminData },
  getLessonJson: { role: 'admin', fn: getLessonJson },
  upsertLesson: { role: 'admin', fn: upsertLesson },
  upsertLessons: { role: 'admin', fn: upsertLessons },
  assign: { role: 'admin', fn: assign },
  unassign: { role: 'admin', fn: unassign },
  uploadIllustration: { role: 'admin', fn: uploadIllustration },
  deleteIllustration: { role: 'admin', fn: deleteIllustration },
  getIllustrations: { role: ['student', 'teacher', 'admin'], fn: getIllustrations }
};

function route(req) {
  const a = ACTIONS[req && req.action];
  if (!a) throw userError('知らない操作です。');
  if (!a.open) checkClassCode(req.classCode);
  if (a.role) req.who = verifyToken(req.token, a.role);
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

function checkClassCode(given) {
  const want = getSetting('classCode');
  if (!want) throw userError('Settings シートに classCode が入っていません。', 'class');
  if (String(given || '').trim() !== want) {
    Utilities.sleep(400); // 総当たりを遅くする
    throw userError('教室コードがちがいます。', 'class');
  }
}

/* ===== パスワード・PIN・通行証 ===== */

function hex(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function sha256(s) {
  return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function makeHash(pass) {
  const salt = Utilities.getUuid().replace(/-/g, '');
  return 'sha256$' + salt + '$' + sha256(salt + ':' + pass);
}

function hashMatches(stored, pass) {
  const m = /^sha256\$([0-9a-f]+)\$([0-9a-f]{64})$/.exec(String(stored || ''));
  return !!m && sha256(m[1] + ':' + pass) === m[2];
}

/**
 * teacherPass / adminPass のハッシュを返す。
 * Settings に平文（teacherPass / adminPass）が書かれていたら、ハッシュにして ○○Hash に入れ、平文は消す。
 */
function passHash(name) {
  const plain = getSetting(name);
  if (plain) {
    withLock(() => {
      const list = rows('Settings');
      const p = list.find(x => x.key.trim() === name);
      if (!p || !p.value.trim()) return;
      const h = list.find(x => x.key.trim() === name + 'Hash');
      const val = makeHash(p.value.trim());
      if (h) updateObj('Settings', h, { value: val });
      else appendObj('Settings', { key: name + 'Hash', value: val });
      updateObj('Settings', p, { value: '' });
    });
  }
  return getSetting(name + 'Hash');
}

function normPin(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return /^\d{1,4}$/.test(s) ? ('000' + s).slice(-4) : s;
}

function failKey(role, id) {
  return 'fail:' + role + ':' + sha256(String(id)).slice(0, 32);
}

function assertNotLocked(role, id) {
  const n = Number(CacheService.getScriptCache().get(failKey(role, id)) || 0);
  if (n >= FAIL_LIMIT) throw userError('何回もまちがえたので、10分たってからもう一度ためしてください。', 'locked');
}

function addFail(role, id, msg) {
  const c = CacheService.getScriptCache(), k = failKey(role, id);
  c.put(k, String(Number(c.get(k) || 0) + 1), FAIL_WAIT_SEC);
  Utilities.sleep(600);
  throw userError(msg, 'login');
}

function tokenSecret() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('tokenSecret');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('tokenSecret', s);
  }
  return s;
}

function b64(s) {
  return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function unb64(s) {
  const pad = '===='.slice(0, (4 - s.length % 4) % 4);
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s + pad)).getDataAsString('UTF-8');
}

/** 通行証のしるし。PIN・パスワード・教室コードが変わると、前の通行証は使えなくなる。 */
function sign(body, fingerprint) {
  const key = tokenSecret();
  const msg = body + '|' + fingerprint + '|' + getSetting('classCode');
  return hex(Utilities.computeHmacSha256Signature(msg, key, Utilities.Charset.UTF_8));
}

function fingerprintOf(role, id) {
  if (role === 'student') {
    const r = rows('Students').find(s => s.studentId.trim() === id && isActive(s.active));
    return r ? 'pin:' + normPin(r.pin) : '';
  }
  if (role === 'teacher') return activeTeachers().indexOf(id) >= 0 ? passHash('teacherPass') : '';
  if (role === 'admin') return passHash('adminPass');
  return '';
}

function makeToken(role, id) {
  const body = b64(JSON.stringify({ r: role, id: id, t: Date.now() }));
  return body + '.' + sign(body, fingerprintOf(role, id));
}

/** role は1つ（'student'）でも、いくつか（['student', 'teacher']）でもよい */
function verifyToken(token, role) {
  const roles = Array.isArray(role) ? role : [role];
  const bad = () => userError('ログインの期限が切れました。もう一度ログインしてください。', 'auth');
  const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m) throw bad();
  let p;
  try { p = JSON.parse(unb64(m[1])); } catch (e) { throw bad(); }
  if (!p || roles.indexOf(p.r) < 0 || !TOKEN_LIFE[p.r] || Date.now() - Number(p.t) > TOKEN_LIFE[p.r]) throw bad();
  const fp = fingerprintOf(p.r, String(p.id));
  if (!fp || sign(m[1], fp) !== m[2]) throw bad();
  return { role: p.r, id: String(p.id) };
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
  if (!st) throw userError('生徒が見つかりません。もう一度ログインしてください。', 'auth');
  return st;
}

function activeTeachers() {
  return rows('Teachers').filter(t => t.name.trim() && isActive(t.active)).map(t => t.name.trim());
}

/** 「4」→「Unit 4」のように、数字だけなら名前を付ける */
function unitLabel(v, word) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return /^\d+$/.test(s) ? word + ' ' + s : s;
}

function noteOf(r) {
  return [r.textbook, r.unit, r.part].map(x => String(x || '').trim()).filter(Boolean).join(' ');
}

function sourceOf(r) {
  const L = parseJson(r.json, null);
  return L && typeof L.source === 'string' ? L.source.trim() : '';
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
  L.note = noteOf(r);
  L.source = typeof L.source === 'string' ? L.source.trim() : '';
  L.words = Array.isArray(L.words) ? L.words : [];
  L.sentences.forEach(s => {
    s.tokens = Array.isArray(s.tokens) ? s.tokens : [];
    s.chunks = Array.isArray(s.chunks) ? s.chunks : [];
    s.end = s.end || '';
  });
  // 使う品詞と役割。v2 までのレッスンには無いので、そのときは全部を使う
  L.posSet = Array.isArray(L.posSet) && L.posSet.length ? POS_KEYS.filter(k => L.posSet.indexOf(k) >= 0) : POS_KEYS.slice();
  const used = OLD_ROLES.filter(r => L.sentences.some(s => s.chunks.some(c => c.role === r)));
  L.roleSet = Array.isArray(L.roleSet) && L.roleSet.length ? ROLES.filter(k => L.roleSet.indexOf(k) >= 0) : ROLES.concat(used);
  return L;
}

/** 出典がないレッスンは、生徒にも講師にも出さない */
function assertSource(L) {
  if (!L.source) throw userError(`レッスン ${L.lessonId} に出典（source）が入っていません。教室長に伝えてください。`);
}

/** 生徒に送る形。答え（pos / alt / chunks / ok / why / example）を削る。 */
function publicLesson(L) {
  return {
    lessonId: L.lessonId, title: L.title, note: L.note || '', grade: L.grade || '', source: L.source,
    posSet: L.posSet, roleSet: L.roleSet,
    sentences: L.sentences.map(s => {
      const o = {
        tokens: s.tokens.map(t => {
          const x = { w: t.w };
          if (t.glue) x.glue = true;
          if (t.punct) x.punct = t.punct;
          return x;
        }),
        end: s.end
      };
      if (s.speaker) o.speaker = s.speaker;
      return o;
    }),
    words: L.words.map(w => ({ w: w.w, sentence: w.sentence })),
    lines: Array.isArray(L.lines) ? L.lines.map(publicLine) : undefined
  };
}

/** 訳の中の {単語:訳} を「（　　）」にする（新出単語の答えを生徒に見せない） */
function maskJa(ja) {
  return String(ja || '').replace(/\{[^:{}]+:[^{}]*\}/g, '（　　）');
}

/** 生徒に送るせりふ。新出単語（new・hide）の意味と、訳の中の答えを削る。 */
function publicLine(l) {
  const o = { text: l.text, ja: maskJa(l.ja), gloss: (l.gloss || []).map(g => (g.new ? { w: g.w, new: true } : g.hide ? { w: g.w, hide: true } : { w: g.w, ja: g.ja })) };
  if (l.speaker) o.speaker = l.speaker;
  if (Number.isInteger(l.sentence)) o.sentence = l.sentence;
  return o;
}

/** その生徒に配られたレッスン（Assignments シートにある分だけ） */
function lessonsForStudent(st) {
  const lessons = rows('Lessons').filter(r => r.lessonId.trim());
  const key = r => ({ grade: r.grade.trim(), unit: r.unit, part: r.part, lessonId: r.lessonId.trim() });
  return rows('Assignments').filter(a => a.studentId.trim() === st.studentId).map(a => {
    const l = lessons.find(r => r.lessonId.trim() === a.lessonId.trim());
    return l ? { row: l, dueDate: a.dueDate } : null;
  }).filter(Boolean).sort((a, b) => byUnitPart(key(a.row), key(b.row)));
}

function assertAssigned(st, lessonId) {
  if (!lessonsForStudent(st).some(x => x.row.lessonId.trim() === String(lessonId).trim())) {
    throw userError('このレッスンはまだ配られていません。');
  }
}

/** その講師画面に出す生徒（そのレッスンを配られた生徒） */
function studentsForLesson(L) {
  const ids = rows('Assignments').filter(a => a.lessonId.trim() === L.lessonId).map(a => a.studentId.trim());
  return activeStudents().filter(s => ids.indexOf(s.studentId) >= 0);
}

function submissionsOf(studentId, lessonId) {
  return rows('Submissions').filter(r => r.studentId.trim() === studentId && r.lessonId.trim() === lessonId)
    .sort((a, b) => Number(a.attempt) - Number(b.attempt));
}

/* ===== レッスン JSON の確認 ===== */

/** まちがいを日本語の文の配列で返す。空なら OK。 */
function lessonErrors(L) {
  const err = [];
  const add = m => { if (err.length < 30) err.push(m); };
  if (!L || typeof L !== 'object' || Array.isArray(L)) return ['JSON の形が正しくありません（{ } で始まる形にしてください）。'];
  const str = v => typeof v === 'string' && v.trim() !== '';
  if (!str(L.lessonId) || !/^[A-Za-z0-9_-]{1,40}$/.test(L.lessonId.trim())) add('lessonId は英数字と - _ だけで、40字までにしてください。');
  if (!str(L.title)) add('title（レッスンの名前）が入っていません。');
  if (!str(L.grade)) add('grade（学年）が入っていません。');
  if (!str(L.source)) add('source（出典）が入っていません。出典がないレッスンは保存できません。');
  const setOk = (v, all) => Array.isArray(v) && v.length && v.every(x => all.indexOf(x) >= 0) && v.every((x, i) => v.indexOf(x) === i);
  const posSet = setOk(L.posSet, POS_KEYS) ? L.posSet : null;
  const roleSet = setOk(L.roleSet, ROLES) ? L.roleSet : null;
  if (!posSet) add(`posSet（使う品詞の一覧）は、${POS_KEYS.join('・')} の中から重ならないように選んで [ ] に入れてください。`);
  if (!roleSet) add(`roleSet（使うかたまりの役割の一覧）は、${ROLES.join('・')} の中から重ならないように選んで [ ] に入れてください。`);
  if (!Array.isArray(L.sentences) || !L.sentences.length) { add('sentences（文）が1つもありません。'); return err; }
  L.sentences.forEach((s, si) => {
    const at = `文${si + 1}`;
    if (!s || !Array.isArray(s.tokens) || !s.tokens.length) { add(`${at}：tokens（単語）がありません。`); return; }
    const n = s.tokens.length;
    if (ENDS.indexOf(s.end) < 0) add(`${at}：end（文の最後の記号）は ${ENDS.join(' ')} のどれかにしてください。`);
    if (s.speaker !== undefined && (typeof s.speaker !== 'string' || s.speaker.length > 30)) add(`${at}：speaker（話し手）は30字までの文字にしてください。`);
    s.tokens.forEach((t, ti) => {
      const w = `${at}の${ti + 1}語目`;
      if (!t || !str(t.w)) { add(`${w}：w（単語）がありません。`); return; }
      if (t.punct !== undefined && (typeof t.punct !== 'string' || !/^[^\s]{1,3}$/.test(t.punct))) add(`${w}「${t.w}」：punct は「,」のような3字までの記号にしてください。`);
      if (POS_KEYS.indexOf(t.pos) < 0) add(`${w}「${t.w}」：pos「${t.pos === undefined ? '' : t.pos}」は使えません（${POS_KEYS.join('・')}）。`);
      else if (posSet && posSet.indexOf(t.pos) < 0) add(`${w}「${t.w}」：pos「${t.pos}」が posSet に入っていません（生徒のボタンに出ないので、正解できません）。`);
      if (t.alt !== undefined && (!Array.isArray(t.alt) || t.alt.some(x => POS_KEYS.indexOf(x) < 0))) add(`${w}「${t.w}」：alt は品詞の記号の並びにしてください。`);
    });
    if (!Array.isArray(s.chunks) || !s.chunks.length) { add(`${at}：chunks（かたまり）がありません。`); return; }
    let next = 0;
    s.chunks.forEach((c, ci) => {
      const k = `${at}の${ci + 1}番目のかたまり`;
      if (!c || !Number.isInteger(c.from) || !Number.isInteger(c.to) || c.from > c.to) { add(`${k}：from / to が正しくありません。`); return; }
      if (c.from !== next) add(`${k}：from が ${next} ではありません（かたまりは前から順に、すきまなく並べます）。`);
      if (ROLES.indexOf(c.role) < 0) add(`${k}：role「${c.role === undefined ? '' : c.role}」は使えません（${ROLES.join('・')}）。`);
      else if (roleSet && roleSet.indexOf(c.role) < 0) add(`${k}：role「${c.role}」が roleSet に入っていません（生徒のボタンに出ないので、正解できません）。`);
      next = c.to + 1;
    });
    if (next !== n) add(`${at}：かたまりが最後の単語（${n - 1}番）まで届いていないか、はみ出しています。`);
  });
  if (L.words !== undefined && !Array.isArray(L.words)) add('words は [ ] の並びにしてください。');
  if (L.lines !== undefined) lineErrors(L, add);
  (Array.isArray(L.words) ? L.words : []).forEach((w, i) => {
    const k = `意味調べの${i + 1}語目`;
    if (!w || !str(w.w)) { add(`${k}：w（単語）がありません。`); return; }
    if (!Number.isInteger(w.sentence) || !L.sentences[w.sentence]) add(`${k}「${w.w}」：sentence は 0〜${L.sentences.length - 1} の番号にしてください。`);
    if (!Array.isArray(w.ok) || !w.ok.length || w.ok.some(x => !str(x))) add(`${k}「${w.w}」：ok（正解にする言葉）を1つ以上入れてください。`);
  });
  return err;
}

/** lines（意味調べのせりふ・訳・単語の意味）の確認 */
function lineErrors(L, add) {
  const str = v => typeof v === 'string' && v.trim() !== '';
  if (!Array.isArray(L.lines) || !L.lines.length) { add('lines（せりふ）は [ ] の並びで、1つ以上入れてください。'); return; }
  // 新出単語は、大文字・小文字を区別せずに words と結びつける（文の始めの Call と、words の call など）
  const wordList = (Array.isArray(L.words) ? L.words : []).map(w => (w && typeof w.w === 'string' ? w.w.toLowerCase() : ''));
  // 新出単語の文（words の sentence）。書きこむ欄（new）は、この文のせりふだけ
  const wordSent = (Array.isArray(L.words) ? L.words : []).map(w => (w ? w.sentence : undefined));
  const newSeen = {};
  let nextSentence = 0;
  L.lines.forEach((l, li) => {
    const at = `せりふ${li + 1}`;
    if (!l || !str(l.text)) { add(`${at}：text（英語の文）がありません。`); return; }
    if (!str(l.ja)) add(`${at}：ja（日本語訳）がありません。`);
    if (l.speaker !== undefined && (typeof l.speaker !== 'string' || l.speaker.length > 30)) add(`${at}：speaker（話し手）は30字までの文字にしてください。`);
    if (l.sentence !== undefined) {
      if (!Number.isInteger(l.sentence) || !L.sentences[l.sentence]) add(`${at}：sentence は 0〜${L.sentences.length - 1} の番号にしてください。`);
      else if (l.sentence !== nextSentence) add(`${at}：sentence が ${nextSentence} ではありません（分析する文は、sentences の順番どおりに1回ずつ）。`);
      else nextSentence++;
    }
    if (!Array.isArray(l.gloss) || !l.gloss.length) { add(`${at}：gloss（単語の意味）がありません。`); return; }
    let pos = 0;
    const marks = [];
    String(l.ja || '').replace(/\{([^:{}]+):[^{}]*\}/g, (m, k) => { marks.push(k); return m; });
    l.gloss.forEach((g, gi) => {
      if (!g || !str(g.w)) { add(`${at}の${gi + 1}語目：w がありません。`); return; }
      const p = l.text.indexOf(g.w, pos);
      if (p < 0) add(`${at}の「${g.w}」：text の中に、この順番で見つかりません。`);
      else pos = p + g.w.length;
      const wi = wordList.indexOf(g.w.toLowerCase());
      if (g.new || g.hide) {
        const kind = g.new ? 'new' : 'hide';
        if (g.new && g.hide) add(`${at}の「${g.w}」：new と hide は、どちらか1つにしてください。`);
        if (wi < 0) add(`${at}の「${g.w}」：${kind} なのに words に入っていません。`);
        else if (g.new && l.sentence !== wordSent[wi]) add(`${at}の「${g.w}」：new（書きこむ欄）にできるのは、words の sentence（文${wordSent[wi] + 1}）のせりふだけです。ほかのせりふで同じ意味なら hide にしてください。`);
        else if (g.hide && l.sentence === wordSent[wi]) add(`${at}の「${g.w}」：words の sentence のせりふなので、hide ではなく new にしてください。`);
        if (g.ja !== undefined) add(`${at}の「${g.w}」：新出単語には ja を書かないでください（答えになるため）。`);
        if (marks.indexOf(g.w) < 0) add(`${at}の「${g.w}」：ja の中に {${g.w}:訳} の印がありません（訳の答えを隠すため）。`);
        if (g.otherMeaning) add(`${at}の「${g.w}」：${kind} と otherMeaning は、いっしょに付けられません。`);
        if (g.new && wi >= 0) newSeen[wordList[wi]] = true;
      } else {
        if (!str(g.ja)) add(`${at}の「${g.w}」：ja（その文の中での意味）がありません。`);
        if (wi >= 0 && !g.otherMeaning) add(`${at}の「${g.w}」：新出単語と同じつづりです。同じ意味なら hide（答えを隠す）、意味がちがう決まった言い方なら otherMeaning を付けてください。`);
        if (wi < 0 && g.otherMeaning) add(`${at}の「${g.w}」：otherMeaning は、新出単語と同じつづりの単語にだけ付けます。`);
      }
    });
    marks.forEach(k => { if (!l.gloss.some(g => g && (g.new || g.hide) && g.w === k)) add(`${at}：ja の {${k}:…} にあたる新出単語（new か hide）が gloss にありません。`); });
  });
  if (nextSentence !== L.sentences.length) add(`lines の中に、分析する文（sentences）が ${L.sentences.length} 個そろっていません（今 ${nextSentence} 個）。`);
  wordList.forEach(w => { if (w && !newSeen[w]) add(`意味調べの「${w}」：words の sentence のせりふの gloss に new として入っていません。`); });
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
    Object.keys(r).forEach(k => { if (/^\d+-\d+$/.test(k) && (ROLES.indexOf(r[k]) >= 0 || OLD_ROLES.indexOf(r[k]) >= 0)) res.roles[si][k] = r[k]; });
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

/* ===== 操作：ログイン ===== */

function login(req) {
  const role = req.role;
  if (role === 'student') {
    const id = String(req.studentId || '').trim();
    const pin = String(req.pin || '').trim();
    if (!id || !/^\d{4}$/.test(pin)) throw userError('生徒番号と、4けたの PIN を入れてください。', 'login');
    assertNotLocked('student', id);
    const r = rows('Students').find(s => s.studentId.trim() === id && isActive(s.active));
    if (r && !String(r.pin).trim()) throw userError('PIN がまだ決まっていません。先生に伝えてください。', 'login');
    if (!r || normPin(r.pin) !== pin) addFail('student', id, '生徒番号か PIN がちがいます。');
    return { version: VERSION, token: makeToken('student', id), studentId: id, name: r.name, grade: r.grade.trim() };
  }
  if (role === 'teacher') {
    const name = String(req.teacherName || '').trim();
    if (activeTeachers().indexOf(name) < 0) throw userError('講師の名前が見つかりません。', 'login');
    const h = passHash('teacherPass');
    if (!h) throw userError('Settings シートに teacherPass が入っていません。', 'login');
    assertNotLocked('teacher', name);
    if (!hashMatches(h, String(req.password || '').trim())) addFail('teacher', name, '講師パスワードがちがいます。');
    return { version: VERSION, token: makeToken('teacher', name), teacherName: name };
  }
  if (role === 'admin') {
    const h = passHash('adminPass');
    if (!h) throw userError('Settings シートに adminPass が入っていません。', 'login');
    assertNotLocked('admin', 'admin');
    if (!hashMatches(h, String(req.password || '').trim())) addFail('admin', 'admin', '管理パスワードがちがいます。');
    return { version: VERSION, token: makeToken('admin', 'admin') };
  }
  throw userError('知らないログインです。');
}

/* ===== 操作：生徒（PIN の通行証が必要） ===== */

function listAssignments(req) {
  const st = findStudent(req.who.id);
  const subs = rows('Submissions').filter(r => r.studentId.trim() === st.studentId);
  const drafts = rows('Drafts').filter(r => r.studentId.trim() === st.studentId);
  const lessons = lessonsForStudent(st).map(({ row, dueDate }) => {
    const id = row.lessonId.trim();
    const mine = subs.filter(r => r.lessonId.trim() === id).sort((a, b) => Number(a.attempt) - Number(b.attempt));
    const last = mine[mine.length - 1];
    return {
      lessonId: id,
      title: row.title || id,
      note: noteOf(row),
      source: sourceOf(row),
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
  const st = findStudent(req.who.id);
  assertAssigned(st, req.lessonId);
  const L = loadLesson(req.lessonId);
  assertSource(L);
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
  const st = findStudent(req.who.id);
  assertAssigned(st, req.lessonId);
  const L = loadLesson(req.lessonId);
  const a = normalize(L, req.answers);
  const savedAt = withLock(() => upsertDraft(st.studentId, L.lessonId, a));
  return { savedAt };
}

function submit(req) {
  const st = findStudent(req.who.id);
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

/* ===== 操作：講師（講師パスワードの通行証が必要） ===== */

/** 「Unit 4」→ 4。数字がなければ大きい数にして、後ろに回す */
function numOf(v) {
  const m = /\d+/.exec(String(v || ''));
  return m ? Number(m[0]) : 9999;
}

/** レッスンを 学年 → Unit → Part → lessonId の順に並べる */
function byUnitPart(a, b) {
  return String(a.grade).localeCompare(String(b.grade), 'ja') || numOf(a.unit) - numOf(b.unit) ||
    numOf(a.part) - numOf(b.part) || String(a.lessonId).localeCompare(String(b.lessonId));
}

function lessonSummaries() {
  return rows('Lessons').filter(r => r.lessonId.trim()).sort((a, b) => byUnitPart(
    { grade: a.grade.trim(), unit: a.unit, part: a.part, lessonId: a.lessonId.trim() },
    { grade: b.grade.trim(), unit: b.unit, part: b.part, lessonId: b.lessonId.trim() })).map(r => ({
    lessonId: r.lessonId.trim(), grade: r.grade.trim(), title: r.title || r.lessonId.trim(),
    note: noteOf(r), source: sourceOf(r), updatedAt: r.updatedAt
  }));
}

function listLessons() {
  return { lessons: lessonSummaries(), teachers: activeTeachers() };
}

function listSubmissions(req) {
  const L = loadLesson(req.lessonId);
  assertSource(L);
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
  const name = on ? req.who.id : '';
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

/* ===== 操作：教室長（管理パスワードの通行証が必要） ===== */

function adminData() {
  const subs = rows('Submissions');
  const lessons = lessonSummaries().map(l => Object.assign(l, {
    submissions: subs.filter(s => s.lessonId.trim() === l.lessonId).length
  }));
  const students = rows('Students').filter(s => s.studentId.trim() && isActive(s.active)).map(s => ({
    studentId: s.studentId.trim(), name: s.name, grade: s.grade.trim(), hasPin: /^\d{4}$/.test(normPin(s.pin))
  }));
  const assignments = rows('Assignments').filter(a => a.lessonId.trim() && a.studentId.trim()).map(a => ({
    lessonId: a.lessonId.trim(), studentId: a.studentId.trim(), dueDate: a.dueDate
  }));
  return { lessons, students, assignments, illustrations: illustrationIndex(), loadedAt: stamp() };
}

function getLessonJson(req) {
  const id = String(req.lessonId || '').trim();
  const r = rows('Lessons').find(x => x.lessonId.trim() === id);
  if (!r) throw userError('このレッスンが見つかりません。');
  const L = parseJson(r.json, null);
  if (!L) throw userError(`レッスン ${id} の json が正しくありません。`);
  ['textbook', 'unit', 'part'].forEach(k => { if (L[k] === undefined && r[k]) L[k] = r[k]; });
  return { lesson: L };
}

/** 保存の前の確認。まちがいがあれば errors、なければシートに書く1行を返す */
function lessonRowOf(L) {
  const errors = lessonErrors(L);
  if (errors.length) return { errors };
  L.lessonId = L.lessonId.trim();
  L.source = L.source.trim();
  const json = JSON.stringify(L);
  if (json.length > 45000) return { errors: ['レッスンが長すぎます（スプレッドシートの1マスに入りません）。2つのレッスンに分けてください。'] };
  return {
    row: {
      lessonId: L.lessonId, grade: String(L.grade).trim(),
      textbook: String(L.textbook || '').trim(), unit: unitLabel(L.unit, 'Unit'), part: unitLabel(L.part, 'Part'),
      title: String(L.title).trim(), json, updatedAt: ''
    }
  };
}

/**
 * レッスンをまとめて保存する。1つでもまちがいがあれば、どれも保存しない。
 * 同じ lessonId のレッスンがもうあるときは上書きする。
 */
function upsertLessons(req) {
  const list = Array.isArray(req.lessons) ? req.lessons : [];
  if (!list.length) throw userError('レッスンが1つもありません。');
  if (list.length > 60) throw userError('一度に保存できるのは60レッスンまでです。分けて保存してください。');
  const checked = list.map((L, i) => Object.assign({ index: i, lessonId: L && typeof L.lessonId === 'string' ? L.lessonId.trim() : '' }, lessonRowOf(L)));
  checked.forEach(c => {
    if (c.row && checked.some(d => d !== c && d.lessonId === c.lessonId)) c.errors = [`同じ lessonId「${c.lessonId}」が2つ以上あります。`];
  });
  const bad = checked.filter(c => c.errors);
  if (bad.length) return { saved: false, errors: bad.map(c => ({ index: c.index, lessonId: c.lessonId, errors: c.errors })) };
  return withLock(() => {
    const now = rows('Lessons');
    const at = stamp();
    let created = 0, updated = 0;
    checked.forEach(c => {
      c.row.updatedAt = at;
      const r = now.find(x => x.lessonId.trim() === c.lessonId);
      if (r) { updateObj('Lessons', r, c.row); updated++; }
      else { appendObj('Lessons', c.row); created++; }
    });
    return { saved: true, created, updated, lessonIds: checked.map(c => c.lessonId), updatedAt: at };
  });
}

/** 1つだけ保存する（同じ lessonId があれば上書き） */
function upsertLesson(req) {
  const r = upsertLessons({ lessons: [req.lesson] });
  if (r.errors) return { saved: false, errors: r.errors[0].errors };
  return { saved: true, created: r.created === 1, lessonId: r.lessonIds[0], updatedAt: r.updatedAt };
}

function dueOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
  if (!m) throw userError('期限の日付が正しくありません。');
  return `${m[1]}/${('0' + m[2]).slice(-2)}/${('0' + m[3]).slice(-2)}`;
}

function assignTargets(req) {
  const id = String(req.lessonId || '').trim();
  if (!rows('Lessons').some(r => r.lessonId.trim() === id)) throw userError('このレッスンが見つかりません。');
  const all = activeStudents().map(s => s.studentId);
  const ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(x => String(x).trim()).filter(x => all.indexOf(x) >= 0);
  if (!ids.length) throw userError('生徒を1人以上えらんでください。');
  return { id, ids: ids.filter((x, i) => ids.indexOf(x) === i) };
}

function assign(req) {
  const { id, ids } = assignTargets(req);
  const due = dueOf(req.dueDate);
  return withLock(() => {
    const now = rows('Assignments').filter(a => a.lessonId.trim() === id);
    let added = 0, updated = 0;
    ids.forEach(sid => {
      const r = now.find(a => a.studentId.trim() === sid);
      if (r) { updateObj('Assignments', r, { dueDate: due }); updated++; }
      else { appendObj('Assignments', { assignmentId: Utilities.getUuid(), lessonId: id, studentId: sid, dueDate: due, createdAt: stamp() }); added++; }
    });
    return { added, updated };
  });
}

/** 配布を取り消す（Assignments の行を消す。下書きと提出は消さない） */
function unassign(req) {
  const { id, ids } = assignTargets(req);
  return withLock(() => {
    const s = sheet('Assignments');
    const del = rows('Assignments').filter(a => a.lessonId.trim() === id && ids.indexOf(a.studentId.trim()) >= 0)
      .map(a => a._row).sort((x, y) => y - x);
    del.forEach(r => s.deleteRow(r));
    return { removed: del.length };
  });
}

/* ===== 挿絵（ドライブの非公開フォルダに置き、ログインした人にだけ返す） ===== */

const ILL_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ILL_NAME = /^([A-Za-z0-9_-]{1,40})-([12])\.(jpg|png|webp)$/;

function illFolder() {
  const id = getSetting('illustrationFolderId');
  if (!id) throw userError('挿絵のフォルダがまだありません。Apps Script で setup を実行してください。');
  return DriveApp.getFolderById(id);
}

/** フォルダの中の挿絵を {lessonId: {1: file, 2: file}} にする */
function illFiles() {
  const out = {};
  const it = illFolder().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const m = ILL_NAME.exec(f.getName());
    if (!m) continue;
    (out[m[1]] = out[m[1]] || {})[m[2]] = f;
  }
  return out;
}

/** 教室長画面用：レッスンごとの挿絵の番号 */
function illustrationIndex() {
  if (!getSetting('illustrationFolderId')) return null;
  const files = illFiles(), o = {};
  Object.keys(files).forEach(id => { o[id] = Object.keys(files[id]).sort().map(Number); });
  return o;
}

function illTarget(req) {
  const id = String(req.lessonId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw userError('lessonId が正しくありません。');
  const n = String(req.index || '');
  if (n !== '1' && n !== '2') throw userError('挿絵の番号は 1 か 2 にしてください。');
  return { id, n };
}

function uploadIllustration(req) {
  const { id, n } = illTarget(req);
  const ext = ILL_TYPES[req.mime];
  if (!ext) throw userError('画像は JPEG・PNG・WebP のどれかにしてください。');
  const data = String(req.data || '');
  if (!data || data.length > 1500000) throw userError('画像が大きすぎます（1MB まで）。');
  const blob = Utilities.newBlob(Utilities.base64Decode(data), req.mime, `${id}-${n}.${ext}`);
  return withLock(() => {
    const old = (illFiles()[id] || {})[n];
    if (old) old.setTrashed(true);
    illFolder().createFile(blob);
    return { lessonId: id, index: Number(n), bytes: blob.getBytes().length };
  });
}

function deleteIllustration(req) {
  const { id, n } = illTarget(req);
  return withLock(() => {
    const old = (illFiles()[id] || {})[n];
    if (old) old.setTrashed(true);
    return { lessonId: id, index: Number(n), deleted: !!old };
  });
}

/** 挿絵を返す。生徒には、配られたレッスンの挿絵だけ返す。 */
function getIllustrations(req) {
  const id = String(req.lessonId || '').trim();
  if (req.who.role === 'student') assertAssigned(findStudent(req.who.id), id);
  if (!getSetting('illustrationFolderId')) return { lessonId: id, images: [] };
  const files = illFiles()[id] || {};
  const images = Object.keys(files).sort().map(k => {
    const b = files[k].getBlob();
    return { index: Number(k), mime: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
  });
  return { lessonId: id, images };
}

/* ===== 最初に1回だけ実行する：シートの準備（v1 から上げるときも、もう一度実行する） ===== */

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

  // Settings：ない項目だけ足す（すでに入っている値は変えない）
  // adminPass は、このプログラムが誰でも見られる所にあるので、見本の値を入れない（教室長が自分で打つ）
  const have = rows('Settings').map(r => r.key.trim());
  [['classCode', 'kyoshitsu-test'], ['teacherPass', 'sensei-test'], ['adminPass', '']].forEach(([k, v]) => {
    if (have.indexOf(k) < 0 && have.indexOf(k + 'Hash') < 0) appendObj('Settings', { key: k, value: v });
  });
  // 挿絵を置く非公開フォルダ（共有はしない）
  if (!getSetting('illustrationFolderId')) {
    const f = DriveApp.createFolder('本文分析ノート 挿絵');
    appendObj('Settings', { key: 'illustrationFolderId', value: f.getId() });
  }
  if (rows('Students').length === 0) {
    [['T01', 'テスト 生徒A', '1111'], ['T02', 'テスト 生徒B', '2222'], ['T03', 'テスト 生徒C', '3333']].forEach(([id, name, pin]) =>
      appendObj('Students', { studentId: id, name, grade: '中1', pin, active: 'TRUE' }));
  }
  if (rows('Teachers').length === 0) {
    appendObj('Teachers', { teacherId: 'K01', name: 'テスト先生', active: 'TRUE' });
  }
  // テスト用レッスンは、いつも最新の形（出典つき）に入れかえる
  const t = rows('Lessons').find(r => r.lessonId.trim() === TEST_LESSON.lessonId);
  const tObj = {
    lessonId: TEST_LESSON.lessonId, grade: TEST_LESSON.grade, textbook: 'テスト用（自作の英文）', unit: '', part: '',
    title: TEST_LESSON.title, json: JSON.stringify(TEST_LESSON), updatedAt: stamp()
  };
  if (t) updateObj('Lessons', t, tObj);
  else appendObj('Lessons', tObj);
  console.log('準備ができました。Settings シートの classCode と teacherPass を書きかえ、adminPass に管理パスワードを打ってください。');
}

/* テスト用レッスン。教科書ではない自作の英文。 */
const TEST_LESSON = {
  lessonId: 'TEST-1',
  grade: '中1',
  title: 'テスト用　ぼくの犬',
  source: '出典：自作の英文（テスト用）',
  posSet: ['名', '代', '動', '冠', '形', '副', '前', '接'],
  roleSet: ['S', 'V', 'O', 'C', '修飾', 'その他'],
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
      chunks: [{ from: 0, to: 0, role: 'その他', why: 'But は前の文とつなぐ語。S・V・O・C・修飾のどれでもないので、その他。' }, { from: 1, to: 1, role: 'S' }, { from: 2, to: 2, role: 'V' }, { from: 3, to: 3, role: '修飾', why: '「速く」は走り方をくわしくする。なくても文は成り立つ。' }]
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
