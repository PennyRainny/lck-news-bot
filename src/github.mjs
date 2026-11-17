// Local-side GitHub plumbing through the gh CLI. Secret values go over stdin only
// (never argv, never logged).
import { execFileSync } from 'node:child_process';

export const WORKFLOW = 'lck-news.yml';
export const repo = () => (process.env.GITHUB_REPO || 'PennyRainny/lck-news-bot').trim();

const gh = (args, opts = {}) => execFileSync('gh', [...args, '--repo', repo()], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

export function setSecret(name, value) {
  gh(['secret', 'set', name], { input: value });
}

export function secretNames() {
  try {
    return JSON.parse(gh(['secret', 'list', '--json', 'name'])).map((s) => s.name);
  } catch {
    return null; // gh missing / not logged in / repo not created yet
  }
}

export function runWorkflow() {
  gh(['workflow', 'enable', WORKFLOW]); // the schedule stays off until setup presses Start
  gh(['workflow', 'run', WORKFLOW, '-f', 'force=true']);
}

export const actionsUrl = () => `https://github.com/${repo()}/actions/workflows/${WORKFLOW}`;
