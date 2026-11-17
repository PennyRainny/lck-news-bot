// Local setup page (http://127.0.0.1:8790). Collects the Discord token in the browser,
// writes it to .env + GitHub secrets, and runs the human-only steps (invite, logins).
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { loadSources, loadState, log, writeEnv } from './util.mjs';
import { botInfo, channelInfo, channelId, identifyOnce, sendText } from './discord.mjs';
import { actionsUrl, repo, runWorkflow, secretNames, setSecret } from './github.mjs';
import { loginAndShip } from './session.mjs';

const PORT = Number(process.env.SETUP_PORT || 8790);
const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0];
let snap = {};
let busy = null;
let note = '';
let tested = false;

async function refresh() {
  const s = { repo: repo(), actionsUrl: actionsUrl(), channelId: channelId(), token: !!process.env.DISCORD_TOKEN };
  s.secrets = secretNames();
  if (s.token) {
    s.bot = await botInfo().catch((e) => ({ error: e.message }));
    if (!s.bot.error) s.channel = await channelInfo().catch((e) => ({ ok: false, error: e.message }));
  }
  s.login = loadState().login;
  s.tested = tested;
  s.sources = loadSources().sources.map((x) => `${x.label} (${x.platform === 'x' ? 'X' : 'IG'})`);
  snap = s;
}

function shipDiscordSecrets() {
  setSecret('DISCORD_TOKEN', process.env.DISCORD_TOKEN);
  setSecret('DISCORD_CHANNEL_ID', channelId());
}

const actions = {
  async token({ token, channel }) {
    token = String(token || '').trim().replace(/^Bot\s+/i, '');
    channel = String(channel || channelId()).trim();
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('That does not look like a bot token (three parts separated by dots).');
    if (!/^\d{17,20}$/.test(channel)) throw new Error('Channel ID must be a 17–20 digit number.');
    const old = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = token;
    try {
      await botInfo();
    } catch (e) {
      process.env.DISCORD_TOKEN = old || '';
      throw new Error(`Discord rejected the token: ${e.message}`);
    }
    writeEnv({ DISCORD_TOKEN: token, DISCORD_CHANNEL_ID: channel });
    shipDiscordSecrets();
    return 'Token OK — saved to .env and GitHub secrets.';
  },
  async channel({ channel }) {
    if (!/^\d{17,20}$/.test(String(channel))) throw new Error('bad channel id');
    writeEnv({ DISCORD_CHANNEL_ID: String(channel) });
    setSecret('DISCORD_CHANNEL_ID', String(channel));
    return `Channel set to ${channel}.`;
  },
  async test() {
    const u = await identifyOnce();
    await sendText(`✅ **LCK News Bot** (${u.username}) is connected and will post LCK news here.`);
    tested = true;
    return 'Test message sent — check the channel.';
  },
  async login({ platform }) {
    if (!['x', 'instagram'].includes(platform)) throw new Error('bad platform');
    if (busy) throw new Error(`busy: ${busy}`);
    busy = `${platform === 'x' ? 'X' : 'Instagram'} login window is open — log in there`;
    loginAndShip(platform, { timeoutMin: 15, kick: false })
      .then((r) => {
        note = r.ok
          ? r.shipped
            ? `${platform === 'x' ? 'X' : 'Instagram'} logged in and sent to GitHub.`
            : `Logged in, but GitHub secret failed: ${r.shipError}`
          : 'Login window closed / timed out.';
      })
      .catch((e) => (note = `Login error: ${e.message}`))
      .finally(async () => {
        busy = null;
        await refresh().catch(() => {});
      });
    return 'Login window opening…';
  },
  async start() {
    shipDiscordSecrets(); // make sure the cloud has the current token + channel
    runWorkflow();
    return 'Cloud run started.';
  },
  async refresh() {
    return 'Refreshed.';
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 20000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

export async function runSetup() {
  await refresh().catch((e) => (note = e.message));
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // only this page may talk to this server (blocks other sites / DNS rebinding)
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(403, { error: 'forbidden' });
    if (req.method === 'POST' && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin))
      return send(403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && req.url === '/api/status') return send(200, { ...snap, busy, note });
      const m = req.method === 'POST' && req.url.match(/^\/api\/(\w+)$/);
      if (m && actions[m[1]]) {
        const msg = await actions[m[1]](await readBody(req));
        if (m[1] !== 'login') await refresh();
        note = msg;
        return send(200, { ...snap, busy, note });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      note = `⚠ ${firstLine(e.stderr) || e.message}`;
      send(400, { ...snap, busy, note, error: note });
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    log(`setup page: ${url} (Ctrl+C to stop)`);
    if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`);
  });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LCK News Bot — setup</title><style>
:root{color-scheme:dark;--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e7e9ee;--mut:#9aa3b2;--ok:#3ecf8e;--bad:#ff6b6b;--acc:#c89b3c}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:760px;margin:0 auto;padding:28px 16px 60px}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 22px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
.step h2{font-size:16px;margin:0 0 6px;display:flex;gap:10px;align-items:center}.n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--line);font-size:13px}
.chip{margin-left:auto;font-size:12px;padding:2px 10px;border-radius:99px;background:var(--line);color:var(--mut)}.chip.ok{background:#173d2c;color:var(--ok)}.chip.bad{background:#401c1f;color:var(--bad)}
ol,ul{margin:6px 0 10px;padding-left:20px;color:var(--mut)}input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:#0c0e12;color:var(--fg);font:inherit;margin:4px 0 8px}
button,a.btn{display:inline-block;padding:8px 14px;border-radius:8px;border:0;background:var(--acc);color:#14110a;font:600 14px system-ui;cursor:pointer;text-decoration:none;margin:4px 6px 0 0}
button.sec,a.sec{background:var(--line);color:var(--fg)}button:disabled{opacity:.5;cursor:default}
#note{position:sticky;top:0;background:#1d2230;border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:10px;min-height:22px}
.mut{color:var(--mut);font-size:13px}code{background:#0c0e12;padding:1px 6px;border-radius:5px}label{font-size:13px;color:var(--mut)}
</style></head><body><main>
<h1>LCK News Bot — setup</h1><p class="sub">Runs free on GitHub Actions (<span id="repo"></span>). Secrets go to this PC's <code>.env</code> and to GitHub Secrets — never into the repo.</p>
<div id="note">Loading…</div>

<div class="step"><h2><span class="n">1</span>Discord bot token<span class="chip" id="c1"></span></h2>
<ol><li><a class="btn sec" href="https://discord.com/developers/applications" target="_blank" rel="noopener">Open Discord Developer Portal</a></li>
<li><b>New Application</b> → name it (e.g. <i>LCK News</i>) → <b>Bot</b> tab → <b>Reset Token</b> → <b>Copy</b>.</li>
<li>Paste it here. It is checked with Discord, then stored.</li></ol>
<label>Bot token</label><input id="tok" type="password" autocomplete="off" placeholder="paste token">
<label>Channel ID</label><input id="chan" inputmode="numeric">
<button onclick="act('token',{token:tok.value,channel:chan.value}).then(()=>tok.value='')">Save token</button></div>

<div class="step"><h2><span class="n">2</span>Invite the bot to your server<span class="chip" id="c2"></span></h2>
<p class="mut">Pick your server and press <b>Authorize</b>. It asks only for View Channel, Send Messages and Embed Links.</p>
<a class="btn" id="inv" target="_blank" rel="noopener">Invite bot</a><button class="sec" onclick="act('refresh')">Re-check channel</button>
<div id="chans"></div></div>

<div class="step"><h2><span class="n">3</span>Test message<span class="chip" id="c3"></span></h2>
<button id="b3" onclick="act('test')">Send test message</button></div>

<div class="step"><h2><span class="n">4</span>Log in to X and Instagram<span class="chip" id="c4"></span></h2>
<p class="mut">A Chrome window opens; log in there and it closes by itself. The session is sent straight to GitHub Secrets. Tip: use a spare account — scraping can get an account limited. Use username + password (Google sign-in may refuse automated windows).</p>
<button onclick="act('login',{platform:'x'})">Log in to X</button><button onclick="act('login',{platform:'instagram'})">Log in to Instagram</button>
<div class="mut" id="lg"></div></div>

<div class="step"><h2><span class="n">5</span>Start the cloud bot<span class="chip" id="c5"></span></h2>
<p class="mut">Runs every ~10 min on GitHub Actions. The first run only memorises existing posts; from then on every new post is sent to Discord.</p>
<button onclick="act('start')">Start now</button><a class="btn sec" id="act" target="_blank" rel="noopener">Open Actions</a>
<p class="mut" id="srcs"></p></div>
</main><script>
const $=id=>document.getElementById(id);let typed=false;$('chan').oninput=()=>typed=true;
function chip(id,ok,txt){const c=$(id);c.className='chip '+(ok===true?'ok':ok===false?'bad':'');c.textContent=txt}
function draw(s){
 $('note').textContent=s.busy||s.note||'Ready.';$('repo').textContent=s.repo||'';$('act').href=s.actionsUrl||'#';
 if(!typed)$('chan').value=s.channelId||'';
 const bot=s.bot&&!s.bot.error;chip('c1',s.token?(bot?true:false):null,bot?('bot: '+s.bot.username):s.token?'token rejected':'not set');
 $('inv').href=bot?s.bot.inviteUrl:'#';
 const ch=s.channel;chip('c2',ch?ch.ok:null,ch?(ch.ok?('#'+ch.name+(ch.guild?' · '+ch.guild:'')):'no access'):'—');
 $('chans').innerHTML=ch&&!ch.ok?'<p class="mut">'+ch.error+'</p>'+(ch.channels||[]).map(c=>'<button class="sec" onclick="act(\\'channel\\',{channel:\\''+c.id+'\\'})">#'+c.name+'</button>').join(''):'';
 chip('c3',s.tested?true:null,s.tested?'sent':'—');
 const sec=s.secrets||[];const L=s.login||{};
 const xs=sec.includes('X_COOKIES'),is=sec.includes('IG_COOKIES');
 chip('c4',xs&&is?true:null,(xs?'X ✓':'X —')+' · '+(is?'IG ✓':'IG —'));
 $('lg').textContent=s.secrets?'':'GitHub CLI not reachable — logins will work locally but cannot reach the cloud.';
 const ready=['DISCORD_TOKEN','DISCORD_CHANNEL_ID'].every(n=>sec.includes(n));chip('c5',ready?true:null,ready?'secrets ready':'waiting');
 $('srcs').textContent='Watching: '+(s.sources||[]).join(', ');
}
async function act(name,body){$('note').textContent='Working…';const r=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});draw(await r.json())}
async function poll(){try{draw(await (await fetch('/api/status')).json())}catch{}setTimeout(poll,3000)}poll();
</script></body></html>`;
