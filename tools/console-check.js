/*
 * 本文分析ノート 動作確認スクリプト（v5 用）
 *
 * 使い方
 *   1. Chrome で index.html を開き、ログインする（生徒・講師・教室長のどれでもよい）。
 *   2. キーボードの F12 を押す（Mac は ⌘ + ⌥ + I）。右か下に「開発者ツール」が出る。
 *   3. 開発者ツールの上のほうにある「Console（コンソール）」を押す。
 *   4. このファイルの中身を全部コピーして、コンソールの一番下の「>」の所に貼り、Enter を押す。
 *      （初めて貼るときは「allow pasting」と打つように言われることがあります。そのとおり打って Enter、もう一度貼る）
 *   5. 表が出る。「結果」がすべて OK なら大丈夫。NG の行があれば、その行を教室長（または Claude）に見せる。
 *
 * 何を確かめるか
 *   ・index.html とサーバー（GAS）の版がそろっているか
 *   ・通信にかかる時間（ミリ秒。1000 ミリ秒 = 1 秒）
 *   ・まちがった PIN・講師パスワード・管理パスワードではログインできないか
 *   ・ログインしていない人や、ちがう立場の人にはデータを返さないか
 *   ・生徒用の通信に答え（pos / alt / role / chunks / ok / why / example）が入っていないか
 *   ・レッスンに出典（source）が入っているか
 *   ・（教室長）まとめて保存するとき、まちがいが1つでもあれば何も保存されないか
 *   ・（生徒）意味調べのせりふに、新出単語の意味と訳の答えが入っていないか
 *   ・挿絵がもらえるか、配られていない人にはもらえないか（挿絵を受けとる時間も測ります）
 *   ・（生徒）まだ確かめていない問題の答えが届いていないか。ログインしていない人や講師は「確かめる」を使えないか
 *   ・画面を描きかえる速さ
 *   ※ まちがったログインを数回ためします。同じ人を何回も続けてためすと、10分ログインできなくなることがあります。
 *
 * おまけ（テスト用の生徒でだけ使う。本当に記録が残ります）
 *   ・HC_CHECK.speed()  … 生徒でレッスンを開いた状態で打つ。意味調べの1語目を「確かめる」して、かかる時間を測ります。
 *     （その1語は ◯ か ✕ に決まります。テスト用の生徒で、まだ確かめていないレッスンで使ってください）
 *   ・HC_CHECK.once()   … 提出がすんだレッスンを開いた状態で打つ。もう一度提出しても、提出がふえない（1回だけ）ことを確かめます。
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
  const expectFail = async (p, codes) => {
    try { await p; } catch (e) { if (!codes || codes.includes(e.code)) return '正しくことわられた'; throw new Error('ちがう理由で失敗：' + e.message); }
    throw new Error('ことわられなかった');
  };
  const wrong = () => 'wrong-' + Date.now();
  const role = S.auth?.role;

  await step('サーバーとの通信（ping）', async () => {
    const j = await HC.api('ping');
    if (j.version !== HC.VERSION) throw new Error(`版がちがう：画面 v${HC.VERSION} / サーバー v${j.version}。GAS を再デプロイしてください。`);
    return `v${j.version}`;
  });
  await step('教室コードの確認', async () => { const j = await HC.api('listTeachers'); return `講師 ${j.teachers.length}人`; });
  await step('まちがった教室コードはことわる', () => expectFail(HC.api('listTeachers', { classCode: wrong() }), ['class']));
  await step('まちがった講師パスワードはことわる', async () => {
    const j = await HC.api('listTeachers');
    if (!j.teachers.length) return '講師がいないので、とばした';
    return expectFail(HC.api('login', { role: 'teacher', teacherName: j.teachers[0], password: wrong() }), ['login', 'locked']);
  });
  await step('まちがった管理パスワードはことわる', () => expectFail(HC.api('login', { role: 'admin', password: wrong() }), ['login', 'locked']));
  await step('ログインしていないと生徒のデータはもらえない', () => expectFail(HC.api('listAssignments', { token: '' }), ['auth']));
  await step('ログインしていないと答えはもらえない', () => expectFail(HC.api('listLessons', { token: '' }), ['auth']));
  await step('ログインしていないと教室長の操作はできない', () => expectFail(HC.api('adminData', { token: '' }), ['auth']));

  if (role === 'student') {
    await step('まちがった PIN はことわる', () => expectFail(HC.api('login', { role: 'student', studentId: 'no-such-' + Date.now(), pin: '0000' }), ['login', 'locked']));
    await step('生徒の通行証では答えをもらえない', () => expectFail(HC.api('listLessons'), ['auth']));
    await step('生徒の通行証では教室長の操作はできない', () => expectFail(HC.api('adminData'), ['auth']));
    let lessonId = S.L?.lessonId;
    await step('宿題の一覧', async () => {
      const j = await HC.api('listAssignments');
      lessonId = lessonId || j.lessons[0]?.lessonId;
      const noSrc = j.lessons.filter(l => !l.source);
      if (noSrc.length) throw new Error('出典がないレッスン：' + noSrc.map(l => l.lessonId).join(', '));
      return `${j.lessons.length}件・どれも出典あり`;
    });
    if (lessonId) {
      await step('レッスンを開く', async () => {
        const j = await HC.api('getLessonForStudent', { lessonId });
        const bad = findKeys(j.lesson, 'lesson').concat(findKeys(j.latest?.result || {}, 'result'));
        if (bad.length) throw new Error('答えが入っている：' + bad.slice(0, 5).join(', '));
        if (!j.lesson.source) throw new Error('出典が入っていない');
        const lines = j.lesson.lines || [];
        const leak = lines.filter(l => /[{}]/.test(l.ja) || (l.gloss || []).some(g => g.new && g.ja !== undefined));
        if (leak.length) throw new Error('新出単語の答えが入っているせりふ：' + leak.length + 'つ');
        // まだ確かめていない問題には、答えもかたまりの場所も入っていないこと
        const items = Object.entries(j.checks?.items || {});
        const early = items.filter(([k, it]) => !it.r && (k[0] === 'c' || it.ans !== undefined || it.why !== undefined));
        if (early.length) throw new Error('まだ確かめていない問題の答えが入っている：' + early.length + 'つ');
        return `${j.lesson.sentences.length}文・せりふ ${lines.length}・確かめた問題 ${items.filter(([, it]) => it.r).length}/${j.total}・答えは入っていない・出典あり`;
      });
      await step('ログインしていないと「確かめる」は使えない', () => expectFail(HC.api('checkItem', { token: '', lessonId, kind: 'mean', w: 'x', answers: {} }), ['auth']));
      await step('挿絵をもらう', async () => {
        const j = await HC.api('getIllustrations', { lessonId });
        const kb = j.images.reduce((t, i) => t + i.data.length * 3 / 4, 0) / 1024;
        return j.images.length ? `${j.images.length}枚・${Math.round(kb)}KB` : '挿絵はまだ登録されていない';
      });
    }
    await step('配られていないレッスンの挿絵はもらえない', () => expectFail(HC.api('getIllustrations', { lessonId: 'NO-SUCH-' + Date.now() }), ['']));
  } else if (role === 'teacher') {
    await step('講師の通行証では教室長の操作はできない', () => expectFail(HC.api('adminData'), ['auth']));
    await step('講師の通行証では生徒の「確かめる」は使えない', () => expectFail(HC.api('checkItem', { lessonId: S.tLessonId || 'x', kind: 'mean', w: 'x', answers: {} }), ['auth']));
    await step('レッスンの一覧（講師）', async () => { const j = await HC.api('listLessons'); return `${j.lessons.length}件`; });
    if (S.tLessonId) {
      await step('提出の一覧（講師）', async () => {
        const j = await HC.api('listSubmissions', { lessonId: S.tLessonId });
        return `${j.students.length}人・提出 ${j.students.filter(s => s.latest).length}人`;
      });
    }
  } else if (role === 'admin') {
    await step('教室長のデータ', async () => {
      const j = await HC.api('adminData');
      const noSrc = j.lessons.filter(l => !l.source);
      if (noSrc.length) throw new Error('出典がないレッスン：' + noSrc.map(l => l.lessonId).join(', '));
      if (!j.illustrations) throw new Error('挿絵のフォルダがない（Apps Script で setup を実行してください）');
      const noIll = j.lessons.filter(l => !j.illustrations[l.lessonId]).length;
      return `レッスン ${j.lessons.length}件・生徒 ${j.students.length}人・配布 ${j.assignments.length}件・挿絵がないレッスン ${noIll}件`;
    });
    await step('出典がないレッスンは保存できない', async () => {
      const j = await HC.api('upsertLesson', { lesson: { lessonId: 'CHECK-NOSOURCE', grade: '中1', title: 'check', source: '', posSet: ['名'], roleSet: ['S'], sentences: [{ tokens: [{ w: 'Hi', pos: '名' }], chunks: [{ from: 0, to: 0, role: 'S' }] }] } });
      if (j.saved) throw new Error('保存されてしまった（Lessons シートの CHECK-NOSOURCE の行を消してください）');
      return 'ことわられた';
    });
    await step('まとめて保存：1つでもまちがいがあれば何も保存しない', async () => {
      const ok = { lessonId: 'CHECK-BATCH-OK', grade: '中1', title: 'check', source: 'check', posSet: ['間', '動', 'その他'], roleSet: ['S', 'V', 'その他'], sentences: [{ speaker: 'A', tokens: [{ w: 'Oh', pos: '間', punct: ',' }, { w: 'I', pos: 'その他' }, { w: 'want to', pos: '動' }], end: '!', chunks: [{ from: 0, to: 0, role: 'その他' }, { from: 1, to: 1, role: 'S' }, { from: 2, to: 2, role: 'V' }] }] };
      const bad = JSON.parse(JSON.stringify(ok)); bad.lessonId = 'CHECK-BATCH-NG'; bad.sentences[0].end = ';';
      const j = await HC.api('upsertLessons', { lessons: [ok, bad] });
      if (j.saved) throw new Error('保存されてしまった（Lessons シートの CHECK-BATCH-OK と CHECK-BATCH-NG の行を消してください）');
      if (!j.errors || j.errors.length !== 1 || j.errors[0].lessonId !== 'CHECK-BATCH-NG') throw new Error('まちがいの知らせ方がおかしい：' + JSON.stringify(j.errors));
      return '1つ目（posSet・roleSet・カンマ・話し手・スペース入りの単語）は OK、2つ目のまちがいだけ知らせて、どちらも保存しなかった';
    });
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
    /* 意味調べの1語目を「確かめる」して、時間を測る（テスト用の生徒で使う。その1語は ◯ か ✕ に決まる） */
    async speed() {
      if (S.auth?.role !== 'student' || !S.L) { console.error('生徒でログインして、レッスンを開いてから実行してください。'); return; }
      const w = (S.L.words || []).find(x => !S.chk?.items?.['m:' + x.w]?.r);
      if (!w) { console.error('まだ確かめていない意味調べの単語がありません。'); return; }
      const t0 = performance.now();
      const r = await HC.api('checkItem', { lessonId: S.L.lessonId, kind: 'mean', w: w.w, answers: S.draft, mode: 'main' });
      const ms = Math.round(performance.now() - t0);
      console.table([{ 確かめた単語: w.w, 結果: r.items['m:' + w.w]?.r === 'o' ? '◯' : '✕', ミリ秒: ms, めやす: ms < 3000 ? 'OK（3秒より速い）' : '遅い（3秒以上）' }]);
      console.log('画面を開き直すと、結果が出ます。');
    },
    /* 提出は1回だけか確かめる（提出がすんだレッスンで使う） */
    async once() {
      if (S.auth?.role !== 'student' || !S.L) { console.error('生徒でログインして、レッスンを開いてから実行してください。'); return; }
      const id = () => 'chk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      const count = async () => (await HC.api('listAssignments')).lessons.find(l => l.lessonId === S.L.lessonId)?.attempts || 0;
      const before = await count();
      if (!before) { console.error('まだ提出していないレッスンです。提出してから使ってください。'); return; }
      const res = await Promise.all([HC.api('submit', { lessonId: S.L.lessonId, answers: S.draft, submissionId: id() }), HC.api('submit', { lessonId: S.L.lessonId, answers: S.draft, submissionId: id() })]);
      const after = await count();
      console.table([{ 前の提出回数: before, 後の提出回数: after, 結果: after === before && res.every(r => r.duplicate) ? 'OK（提出はふえない）' : 'NG' }]);
    }
  };
})();
