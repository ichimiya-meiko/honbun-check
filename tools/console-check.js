/*
 * 本文分析ノート 動作確認スクリプト（v1 用）
 *
 * 使い方
 *   1. Chrome で index.html を開き、ログインする（生徒でも講師でもよい）。
 *   2. キーボードの F12 を押す（Mac は ⌘ + ⌥ + I）。右か下に「開発者ツール」が出る。
 *   3. 開発者ツールの上のほうにある「Console（コンソール）」を押す。
 *   4. このファイルの中身を全部コピーして、コンソールの一番下の「>」の所に貼り、Enter を押す。
 *      （初めて貼るときは「allow pasting」と打つように言われることがあります。そのとおり打って Enter、もう一度貼る）
 *   5. 表が出る。「結果」がすべて OK なら大丈夫。NG の行があれば、その行を教室長（または Claude）に見せる。
 *
 * 何を確かめるか
 *   ・index.html とサーバー（GAS）の版がそろっているか
 *   ・通信にかかる時間（ミリ秒。1000 ミリ秒 = 1 秒）
 *   ・生徒用の通信に答え（pos / alt / role / chunks / ok / why / example）が入っていないか
 *   ・まちがった合言葉では講師用のデータがもらえないか
 *   ・画面を描きかえる速さ
 *
 * おまけ（テスト用の生徒でだけ使う。提出が2回ふえます）
 *   生徒でログインしてレッスンを開いた状態で、コンソールに  HC_CHECK.concurrent()  と打って Enter。
 *   同時に2回提出して、どちらも欠けずに保存されるかを確かめます。
 */
(async () => {
  const HC = window.HC;
  if (!HC) { console.error('本文分析ノートのページで実行してください。'); return; }
  const S = HC.state, rows = [];
  const FORBIDDEN = ['pos', 'alt', 'role', 'chunks', 'ok', 'why', 'example'];
  const step = async (label, fn) => {
    const t0 = performance.now();
    try {
      const note = await fn();
      rows.push({ 項目: label, 結果: 'OK', ミリ秒: Math.round(performance.now() - t0), メモ: note || '' });
    } catch (e) {
      rows.push({ 項目: label, 結果: 'NG', ミリ秒: Math.round(performance.now() - t0), メモ: e.message });
    }
  };
  const findKeys = (obj, where, found = []) => {
    if (Array.isArray(obj)) obj.forEach((x, i) => findKeys(x, `${where}[${i}]`, found));
    else if (obj && typeof obj === 'object') Object.keys(obj).forEach(k => {
      if (FORBIDDEN.includes(k)) found.push(`${where}.${k}`);
      findKeys(obj[k], `${where}.${k}`, found);
    });
    return found;
  };
  const expectFail = async (p, code) => {
    try { await p; } catch (e) { if (!code || e.code === code) return '正しくことわられた'; throw new Error('ちがう理由で失敗：' + e.message); }
    throw new Error('ことわられなかった');
  };

  await step('サーバーとの通信（ping）', async () => {
    const j = await HC.api('ping');
    if (j.version !== HC.VERSION) throw new Error(`版がちがう：画面 v${HC.VERSION} / サーバー v${j.version}。GAS を再デプロイしてください。`);
    return `v${j.version}`;
  });
  await step('ログイン（教室コード）', async () => { const j = await HC.api('login'); return `生徒 ${j.students.length}人・講師 ${j.teachers.length}人`; });
  await step('まちがった教室コードはことわる', () => expectFail(HC.api('login', { classCode: 'wrong-' + Date.now() }), 'class'));
  await step('まちがった合言葉では答えをもらえない', () => expectFail(HC.api('listLessons', { teacherPass: 'wrong-' + Date.now() }), 'teacher'));

  if (S.auth?.role === 'student') {
    let lessonId = S.L?.lessonId;
    await step('宿題の一覧', async () => {
      const j = await HC.api('listAssignments', { studentId: S.auth.studentId });
      lessonId = lessonId || j.lessons[0]?.lessonId;
      return `${j.lessons.length}件`;
    });
    if (lessonId) {
      await step('レッスンを開く', async () => {
        const j = await HC.api('getLessonForStudent', { studentId: S.auth.studentId, lessonId });
        const bad = findKeys(j.lesson, 'lesson').concat(findKeys(j.latest?.result || {}, 'result'));
        if (bad.length) throw new Error('答えが入っている：' + bad.slice(0, 5).join(', '));
        return `${j.lesson.sentences.length}文・答えは入っていない`;
      });
    }
  } else if (S.auth?.role === 'teacher') {
    await step('レッスンの一覧（講師）', async () => { const j = await HC.api('listLessons'); return `${j.lessons.length}件`; });
    if (S.tLessonId) {
      await step('提出の一覧（講師）', async () => {
        const j = await HC.api('listSubmissions', { lessonId: S.tLessonId });
        return `${j.students.length}人・提出 ${j.students.filter(s => s.latest).length}人`;
      });
    }
  } else {
    rows.push({ 項目: 'ログイン後の確認', 結果: 'とばした', ミリ秒: 0, メモ: 'ログインしてからもう一度実行すると、もっと確かめられます' });
  }

  await step('画面の描きかえ（20回の平均）', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) HC.render();
    const ms = (performance.now() - t0) / 20;
    if (ms > 100) throw new Error(`遅い：1回 ${ms.toFixed(1)} ミリ秒`);
    return `1回 ${ms.toFixed(1)} ミリ秒`;
  });

  console.table(rows);
  const ng = rows.filter(r => r.結果 === 'NG').length;
  console.log(ng ? `NG が ${ng} 件あります。` : 'すべて OK です。');

  window.HC_CHECK = {
    /* 同時に2回提出して、どちらも保存されるか確かめる（テスト用の生徒で使う） */
    async concurrent() {
      if (S.auth?.role !== 'student' || !S.L) { console.error('生徒でログインして、レッスンを開いてから実行してください。'); return; }
      const base = { studentId: S.auth.studentId, lessonId: S.L.lessonId, answers: S.draft };
      const id = () => 'chk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      const before = (await HC.api('listAssignments', { studentId: S.auth.studentId })).lessons.find(l => l.lessonId === S.L.lessonId)?.attempts || 0;
      const t0 = performance.now();
      const res = await Promise.all([HC.api('submit', { ...base, submissionId: id() }), HC.api('submit', { ...base, submissionId: id() })]);
      const ms = Math.round(performance.now() - t0);
      const after = (await HC.api('listAssignments', { studentId: S.auth.studentId })).lessons.find(l => l.lessonId === S.L.lessonId)?.attempts || 0;
      const attempts = res.map(r => r.attempt).sort((a, b) => a - b);
      const ok = after === before + 2 && attempts[0] !== attempts[1];
      console.table([{ 前の提出回数: before, 後の提出回数: after, 今回の回数: attempts.join(' と '), ミリ秒: ms, 結果: ok ? 'OK（どちらも保存された）' : 'NG' }]);
      const dupId = id();
      const d = await Promise.all([HC.api('submit', { ...base, submissionId: dupId }), HC.api('submit', { ...base, submissionId: dupId })]);
      const after2 = (await HC.api('listAssignments', { studentId: S.auth.studentId })).lessons.find(l => l.lessonId === S.L.lessonId)?.attempts || 0;
      console.table([{ 確かめたこと: '同じ提出が2回届いたとき', 増えた回数: after2 - after, 結果: after2 - after === 1 && d[0].attempt === d[1].attempt ? 'OK（1回分だけ保存）' : 'NG' }]);
    }
  };
})();
