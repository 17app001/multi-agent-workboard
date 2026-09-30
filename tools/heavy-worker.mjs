// 在 worker thread 執行會長時間同步掃描 log 的運算(用量/分析),避免卡住 server 主執行緒。
// 由 server.mjs 的 heavy() 啟動;結果以 postMessage 回傳(structured clone,純 JSON 資料即可)。
import { parentPort, workerData } from 'node:worker_threads';
import { collectUsage, collectRunAnalytics } from './usage.mjs';

try {
  const { kind, agents, runsDir } = workerData;
  const value = kind === 'usage' ? collectUsage(agents, runsDir)
    : kind === 'analytics' ? collectRunAnalytics(runsDir, agents)
    : null;
  parentPort.postMessage({ ok: true, value });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}
