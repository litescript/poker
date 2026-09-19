/**
 * Engine checks for pokerpot.
 *
 * The betting engine lives inside index.html's IIFE so the page stays a single
 * file. This pulls the script out, exposes the pure functions, and exercises
 * them against hands with known answers.  Run: node test/engine.test.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(root, "index.html"), "utf8");
const body = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
const EXPORTS = "newTable,makePlayer,startHand,act,pots,potTotal,award,settlement,stakes,chipAudit,rotation,byId";
const out = join(mkdtempSync(join(tmpdir(), "pokerpot-")), "engine.cjs");
writeFileSync(out, body.replace("})();", `globalThis.__T={${EXPORTS}};\n})();`));

const node = new Proxy(function(){}, {
  get:(t,k)=> k==='style'||k==='dataset'||k==='classList' ? node
            : k==='value'||k==='textContent'||k==='innerHTML'||k==='className' ? ''
            : typeof k==='symbol' ? undefined : node,
  set:()=>true, apply:()=>node });
globalThis.document = { createElement:()=>node, createDocumentFragment:()=>node, querySelector:()=>node,
  querySelectorAll:()=>[], addEventListener(){} };
globalThis.window = {};
globalThis.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
globalThis.confirm = ()=>true;
globalThis.setTimeout = (f)=>0;
await import(pathToFileURL(out).href);
const T = globalThis.__T;

const mk = (names) => {
  const t = T.newTable('test');
  t.players = names.map((n,i)=>{ const p=T.makePlayer(n,i); p.stack=t.config.buyinChips; return p; });
  t.buttonId = t.players[0].id;
  return t;
};
const nm = (s,id)=>T.byId(s,id).name;
let fails = 0;
const chk = (label, got, want) => {
  const ok = JSON.stringify(got)===JSON.stringify(want);
  if(!ok) fails++;
  console.log((ok?'  ok  ':'  FAIL') + '  ' + label + (ok?'':`\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

console.log('\n— blinds & action order, 4-handed (button = Ada) —');
let s = mk(['Ada','Bry','Cal','Dev']);
T.startHand(s);
chk('SB is Bry (left of button)', nm(s,s.hand.sbId), 'Bry');
chk('BB is Cal', nm(s,s.hand.bbId), 'Cal');
chk('first to act is Dev (UTG)', nm(s,s.hand.toAct), 'Dev');
chk('pot after blinds', T.potTotal(s), 75);

console.log('\n— heads-up: button posts the small blind —');
let h = mk(['Ada','Bry']);
T.startHand(h);
chk('button Ada posts SB', nm(h,h.hand.sbId), 'Ada');
chk('Bry posts BB', nm(h,h.hand.bbId), 'Bry');
chk('button acts first preflop', nm(h,h.hand.toAct), 'Ada');

console.log('\n— a folded-round: everyone folds to the BB —');
s = mk(['Ada','Bry','Cal','Dev']);
T.startHand(s);
T.act(s,'fold'); T.act(s,'fold'); T.act(s,'fold');
chk('pending win flagged for Cal', nm(s, s.pending.winner), 'Cal');
const potWas = T.potTotal(s);
T.award(s, T.pots(s).map(()=>[s.pending.winner]));
chk('award returns cleanly', T.byId(s,'x')||0, 0);
const cal = s.players.find(p=>p.name==='Cal');
chk('Cal stack = 2000 - 50 bb + 75 pot', cal.stack, 2000-50+potWas);
chk('hand cleared', s.hand, null);
chk('button moved to Bry', nm(s,s.buttonId), 'Bry');

console.log('\n— street advance: call, call, check round —');
s = mk(['Ada','Bry','Cal','Dev']);
T.startHand(s);
T.act(s,'call');            // Dev calls 50
T.act(s,'call');            // Ada calls 50
T.act(s,'call');            // Bry completes SB
T.act(s,'check');           // Cal (BB) checks its option
chk('street is flop', s.hand.street, 'flop');
chk('pot is 200', T.potTotal(s), 200);
chk('flop action opens on Bry (left of button)', nm(s,s.hand.toAct), 'Bry');

console.log('\n— min-raise enforcement & re-opened action —');
s = mk(['Ada','Bry','Cal','Dev']);
T.startHand(s);
T.act(s,'raise',150);       // Dev raises to 150
chk('currentBet 150', s.hand.currentBet, 150);
chk('lastRaise 100', s.hand.lastRaise, 100);
chk('action back to Ada', nm(s,s.hand.toAct), 'Ada');

console.log('\n— side pots: a short stack all-in —');
s = mk(['Ada','Bry','Cal']);
s.players[2].stack = 300;   // Cal is short
T.startHand(s);
// seats: Bry(SB) Cal(BB) Ada(btn, first to act 3-handed)
T.act(s,'raise',500);       // Ada raises to 500
T.act(s,'call');            // Bry calls 500
T.act(s,'call');            // Cal all-in for 300
const ps = T.pots(s);
chk('two pots', ps.length, 2);
chk('main pot 900 (300 x3)', ps[0].amount, 900);
chk('main pot eligible: all three', ps[0].eligible.map(i=>nm(s,i)).sort(), ['Ada','Bry','Cal']);
chk('side pot 400 (200 x2)', ps[1].amount, 400);
chk('side pot excludes Cal', ps[1].eligible.map(i=>nm(s,i)).sort(), ['Ada','Bry']);
chk('total chips conserved', T.potTotal(s) + s.players.reduce((a,p)=>a+p.stack,0), 2000+2000+300);

console.log('\n— folded money stays in the pot but wins nothing —');
s = mk(['Ada','Bry','Cal']);
T.startHand(s);
T.act(s,'raise',200);       // Ada to 200
T.act(s,'fold');            // Bry folds (25 SB dead)
T.act(s,'call');            // Cal calls
const p2 = T.pots(s);
chk('one pot of 425', p2.map(x=>x.amount), [425]);
chk('Bry not eligible', p2[0].eligible.map(i=>nm(s,i)).sort(), ['Ada','Cal']);

console.log('\n— split pot: odd chip left of the button —');
s = mk(['Ada','Bry','Cal']);
T.startHand(s);
T.act(s,'raise',75); T.act(s,'call'); T.act(s,'call');
const before = s.players.map(p=>p.stack);
const bry = s.players.find(p=>p.name==='Bry'), cal2 = s.players.find(p=>p.name==='Cal');
T.award(s, [[bry.id, cal2.id]]);
chk('225 split 113/112 with odd chip to Bry (first left of button)',
    [bry.stack - before[1], cal2.stack - before[2]], [113,112]);

console.log('\n— settlement: nets clear to zero —');
s = mk(['Ada','Bry','Cal','Dev']);
s.players[0].stack = 3500; s.players[1].stack = 2500;
s.players[2].stack = 1000; s.players[3].stack = 1000;
const pay = T.settlement(s);
const net = {}; for(const t of pay){ net[t.from]=(net[t.from]||0)-t.amt; net[t.to]=(net[t.to]||0)+t.amt; }
chk('transfers balance to zero', Math.round(Object.values(net).reduce((a,b)=>a+b,0)*100), 0);
chk('Ada collects $15', Math.round(net['Ada']*100)/100, 15);
chk('audit balanced', T.chipAudit(s).drift, 0);

console.log(fails ? `\n${fails} FAILING\n` : '\nall engine checks pass\n');
