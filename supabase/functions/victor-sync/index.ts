/**
 * Victor 词库同步 Edge Function (v1.24.0)
 *
 * 作用: 把共享底座词库(vw_* 四表) 整份复制到指定用户私有四表(uw_*), 后端执行, 不依赖浏览器常驻。
 *       v1.24.0 起废弃 detail JSONB 快照, 富内容改为结构化四表, 与 Victor 底座字段 100% 一致。
 * 触发: 前端点「同步 Victor」→ POST { syncCode }
 *
 * 执行模型:
 *   1. 创建 sync_jobs 任务记录(pending), 服务端同步分批执行全程 (每批调 victor_sync_batch RPC)
 *   2. 每批完成即把进度写回 sync_jobs —— 进度在数据库, 不在浏览器内存
 *   3. Edge Function 在服务端持续运行, 前端即使关闭浏览器/离开页面也不影响同步继续
 *   4. 用户重进词库页 → 调 victor_sync_status RPC 查最近任务 → 显示进度/最终结果
 *   (同步全程在服务端完成; 前端发起请求后由系统调用, 无需保持页面前台)
 *
 * 环境变量(默认注入): SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * verify_jwt=false: 前端用 anon key 调用; 同步只写调用者自己的 syncCode, 风险可控
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BATCH = 200; // 每批词数

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

/** 调 PostgREST RPC (service_role 绕过 RLS) */
async function rpc(func: string, params: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${func}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${func} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** 直接写 sync_jobs (service_role) */
async function updateJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_jobs?id=eq.${jobId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...patch, updated_at: Date.now() }),
  });
}

/** 创建任务并返回 id */
async function createJob(syncCode: string): Promise<string> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/sync_jobs`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ sync_code: syncCode, status: "pending" }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`createJob HTTP ${resp.status}: ${text.slice(0, 200)}`);
  const rows = JSON.parse(text);
  return rows[0].id;
}

/** 取底座总词数 */
async function baseTotal(): Promise<number> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/vw_words?select=id&limit=1`,
    {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Prefer": "count=exact" },
    }
  );
  const cr = resp.headers.get("content-range") || "";
  const m = cr.match(/\/\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** 后台分批同步全流程 */
async function runSync(jobId: string, syncCode: string): Promise<void> {
  try {
    const total = await baseTotal();
    await updateJob(jobId, { status: "running", total });

    let offset = 0;
    let processed = 0;

    // 最多 100 批 (2 万词上限), 防止异常死循环
    // v1.24.0: 调用 victor_copy_batch, 把底座四表整份复制到用户私有 uw_* 四表
    for (let i = 0; i < 100; i++) {
      const res = await rpc("victor_copy_batch", { p_sync_code: syncCode, p_offset: offset, p_limit: BATCH });
      const row = Array.isArray(res) ? res[0] : res;
      const done = Number(row?.processed || 0);
      processed += done;
      offset += done;
      await updateJob(jobId, { processed, added: processed, enriched: 0 });
      if (done < BATCH) break; // 最后一批
    }

    await updateJob(jobId, { status: "done", processed, added: processed, enriched: 0 });
  } catch (e) {
    await updateJob(jobId, { status: "failed", error: String(e?.message || e).slice(0, 500) });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const syncCode = String(body.syncCode || "").trim();
    if (!syncCode) return json({ error: "缺少 syncCode" }, 400);

    // 防重复: 该用户已有 pending/running 任务则直接返回
    const chk = await fetch(
      `${SUPABASE_URL}/rest/v1/sync_jobs?sync_code=eq.${encodeURIComponent(syncCode)}` +
        `&status=in.(pending,running)&order=created_at.desc&limit=1&select=id,status`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const existing = await chk.json().catch(() => []);
    if (Array.isArray(existing) && existing.length) {
      return json({ jobId: existing[0].id, status: existing[0].status, reused: true });
    }

    const jobId = await createJob(syncCode);

    // 服务端同步执行全程: 前端断开请求不影响已在服务端运行的函数;
    // 进度每批写库, 重进可查。await 保证函数不提前结束被回收。
    await runSync(jobId, syncCode);

    return json({ jobId, status: "done" });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
