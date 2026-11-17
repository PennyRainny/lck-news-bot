// Local login -> ship the session to the cloud (GitHub secret) -> poke the workflow.
import { LOGIN, interactiveLogin } from './browser.mjs';
import { runWorkflow, setSecret } from './github.mjs';
import { loadState, log, saveState } from './util.mjs';

const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0];

export async function loginAndShip(platform, { url, timeoutMin = 15, kick = true } = {}) {
  const cookies = await interactiveLogin(platform, { url, timeoutMin });
  const state = loadState();
  state.login[platform] = { ok: !!cookies, at: Date.now() };
  if (cookies) {
    delete state.alerts[platform];
    delete state.humanWaitUntil[platform];
    state.lastRun[platform] = 0;
  }
  saveState(state);
  if (!cookies) return { ok: false };

  const result = { ok: true, shipped: false };
  try {
    setSecret(LOGIN[platform].secret, JSON.stringify(cookies));
    result.shipped = true;
    log(`[${platform}] session saved to GitHub secret ${LOGIN[platform].secret}`);
  } catch (e) {
    result.shipError = firstLine(e.stderr) || firstLine(e.message);
    log(`[${platform}] could not update the GitHub secret: ${result.shipError}`);
    return result;
  }
  if (kick) {
    try {
      runWorkflow(); // cloud picks the new session up now instead of at the next tick
    } catch (e) {
      log(`workflow trigger failed (the schedule will pick it up): ${firstLine(e.stderr) || firstLine(e.message)}`);
    }
  }
  return result;
}
