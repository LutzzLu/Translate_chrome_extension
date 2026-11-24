// Unit tests for extension/lib/markers.js. Run: node tests/markers.test.js
require('path'); require(require('path').join(__dirname, '..', 'extension', 'lib', 'markers.js'));
const M = globalThis.PTXMarkers;
const assert = require('assert');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('valid atoms + pairs', () => {
  const kinds = [null, 'pair', 'atom', 'atom'];
  const r = M.parse('我们发现⟦1⟧TP53⟦/1⟧突变富集⟦2⟧⟦3⟧。', kinds);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.tokens.map(x => x.t), ['text', 'open', 'text', 'close', 'text', 'atom', 'atom', 'text']);
});
t('tolerant spacing inside markers', () => {
  const r = M.parse('见解⟦ 1 ⟧。', [null, 'atom']); assert.ok(r.ok);
});
t('missing atom detected and repaired before final punctuation', () => {
  const r = M.parse('丰富的生物学见解。', [null, 'atom'], { repair: true });
  assert.ok(!r.ok && r.repaired);
  assert.deepStrictEqual(r.tokens, [{ t: 'text', v: '丰富的生物学见解' }, { t: 'atom', k: 1 }, { t: 'text', v: '。' }]);
});
t('duplicate atom dropped in repair', () => {
  const r = M.parse('a⟦1⟧ b⟦1⟧', [null, 'atom'], { repair: true });
  assert.strictEqual(r.tokens.filter(x => x.t === 'atom').length, 1);
});
t('misnested pair fails strict parse', () => {
  const r = M.parse('⟦1⟧a⟦2⟧b⟦/1⟧c⟦/2⟧', [null, 'pair', 'pair']);
  assert.ok(!r.ok);
});
t('broken pair repaired by dropping formatting, keeping text', () => {
  const r = M.parse('⟦1⟧a b', [null, 'pair'], { repair: true });
  assert.deepStrictEqual(r.tokens, [{ t: 'text', v: 'a b' }]);
});
t('full-width citation brackets restored', () => {
  assert.strictEqual(M.prepare('结果（⟦1⟧，⟦2⟧）显示', 'zh-CN'), '结果(⟦1⟧, ⟦2⟧)显示');
  assert.strictEqual(M.prepare('结果【⟦1⟧】', 'zh-CN'), '结果[⟦1⟧]');
  assert.strictEqual(M.prepare('结果（⟦1⟧；⟦2⟧）', 'zh-CN'), '结果(⟦1⟧; ⟦2⟧)');
  // non-citation parentheses untouched
  assert.strictEqual(M.prepare('（图⟦1⟧）', 'zh-CN'), '（图⟦1⟧）');
});
t('CJK spaces around markers removed', () => {
  assert.strictEqual(M.prepare('图 ⟦1⟧ 和扩展数据图 ⟦2⟧', 'zh-CN'), '图⟦1⟧和扩展数据图⟦2⟧');
  assert.strictEqual(M.prepare('Fig. ⟦1⟧ and', 'en'), 'Fig. ⟦1⟧ and');
});
t('hasWords', () => {
  for (const s of ['1', '1,2,3', '4–6', '1a', 'S3', 'n', 'P', '(12)', 'et al.', '  ', 'α']) assert.ok(!M.hasWords(s), s);
  for (const s of ['TP53', 'in vivo', 'Methods', 'E. coli', '中文', 'Smith et al., 2019']) assert.ok(M.hasWords(s), s);
});
t('escapeText neutralises stray markers', () => {
  assert.strictEqual(M.escapeText('a⟦b⟧'), 'a[b]');
});

t('only atoms missing: formatting kept, atoms placed next to source neighbours', () => {
  const kinds = [null, 'atom', 'pair', 'atom'];
  const r = M.parse('甲⟦2⟧乙⟦/2⟧丙。', kinds, { repair: true });
  assert.ok(!r.ok && r.pairsOk);
  const seq = r.tokens.map(x => x.t === 'text' ? x.v : (x.t === 'open' ? '<' : x.t === 'close' ? '>' : '') + x.k).join('|');
  assert.strictEqual(seq, '甲|1|<2|乙|>2|3|丙。');
});
t('real case: Google dropped a clause with its citations ⟦21⟧⟦22⟧', () => {
  const kinds = [null]; for (let k = 1; k <= 22; k++) kinds.push(k === 5 ? 'pair' : 'atom');
  const out = '甲⟦1⟧⟦2⟧⟦3⟧⟦4⟧⟦5⟧乙⟦/5⟧⟦6⟧⟦7⟧⟦8⟧⟦9⟧⟦10⟧⟦11⟧⟦12⟧⟦13⟧⟦14⟧⟦15⟧⟦16⟧⟦17⟧⟦18⟧⟦19⟧⟦20⟧丙。';
  const r = M.parse(out, kinds, { repair: true });
  const atoms = r.tokens.filter(x => x.t === 'atom').map(x => x.k);
  assert.deepStrictEqual(atoms.slice(-3), [20, 21, 22]);
  assert.ok(r.tokens.some(x => x.t === 'open' && x.k === 5));
});
t('splitUrls keeps trailing punctuation out of the URL', () => {
  const parts = M.splitUrls('see https://example.org/x?a=1&oldid=5. Then www.foo.com/a)');
  assert.deepStrictEqual(parts, [
    { url: false, v: 'see ' }, { url: true, v: 'https://example.org/x?a=1&oldid=5' },
    { url: false, v: '. Then ' }, { url: true, v: 'www.foo.com/a' }, { url: false, v: ')' }]);
  assert.ok(M.isUrlText(' https://en.wikipedia.org/w/index.php?title=A '));
  assert.ok(!M.isUrlText('see https://x.org'));
});
console.log(n, 'tests passed');
