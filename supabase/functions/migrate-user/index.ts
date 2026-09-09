/**
 * 老用户迁移 Edge Function (v1.9.0 安全加固)
 *
 * 作用: 把 v1.8.x 之前用 "username + SHA-256 哈希" 注册的老用户,
 *       自动迁移到 Supabase Auth (auth.users), 并回填 words/records/user_auth 的 user_id。
 *
 * 触发时机: 前端登录时, verify_login 通过但 user_auth.user_id 为空 → 调用本函数
 *
 * 输入 (JSON body):
 *   { username, password, pwd_hash }
 *   - password:  明文密码 (用于在 Supabase Auth 建 bcrypt 账号; HTTPS 下传输安全)
 *   - pwd_hash:  前端算的 SHA-256(username+password+salt), 用于二次校验防劫持
 *
 * 安全设计:
 *   1. 内部先调 verify_login RPC 用 pwd_hash 校验 → 没有正确密码无法触发迁移
 *   2. 即使恶意者直接调本函数, 也只能给"他知道密码"的用户建账号, 无法窃取数据
 *   3. 本函数持有 service_role (服务端密钥), 前端不可见
 *
 * 环境变量 (Supabase 默认注入, 无需配置):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const EMAIL_DOMAIN = "beidanci.local";

/** 调 Supabase RPC (SECURITY DEFINER, service_role 绕过 RLS) */
async function callRpc(func: string, params: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${func}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const text = await resp.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** PATCH 表 (service_role 绕过 RLS, 用于回填 user_id) */
async function patchTable(table: string, filter: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body),
  });
}

/**
 * 在 Supabase Auth 建 user:
 *   - 成功 → 返回 uid
 *   - email 已存在 → listUsers 查现有 uid (幂等, 重试安全)
 */
async function ensureAuthUser(email: string, password: string): Promise<{ uid: string | null; error?: string }> {
  // 1. 尝试 createUser
  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,   // 假邮箱域, 直接置为已确认, 免邮件流程
      app_metadata: { provider: "email" },
    }),
  });

  if (createResp.ok) {
    const created = await createResp.json();
    // 新版 Supabase 返回 user 对象 (含 id)
    const uid = created?.id || created?.user?.id || null;
    if (uid) return { uid };
    return { uid: null, error: "createUser 响应无 id" };
  }

  // 2. 已存在 (422 user_already_exists) → 查现有 uid
  if (createResp.status === 422 || createResp.status === 409) {
    return await findUserIdByEmail(email);
  }

  // 3. 其他错误
  const errText = await createResp.text().catch(() => "");
  return { uid: null, error: `createUser HTTP ${createResp.status}: ${errText}` };
}

/** 按 email 在 auth.users 查 uid (admin listUsers keywords 模糊匹配 + 精确过滤) */
async function findUserIdByEmail(email: string): Promise<{ uid: string | null; error?: string }> {
  const resp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&keywords=${encodeURIComponent(email)}`,
    {
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
    },
  );
  if (!resp.ok) {
    return { uid: null, error: `listUsers HTTP ${resp.status}` };
  }
  const data = await resp.json();
  const users: Array<{ id: string; email: string }> = data?.users || data || [];
  // keywords 是模糊匹配, 需精确比对 email
  const hit = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  if (!hit) return { uid: null, error: "user_not_found_in_auth" };
  return { uid: hit.id };
}

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    const { username, password, pwd_hash } = await req.json();
    if (!username || !password || !pwd_hash) {
      return json({ success: false, error: "缺少 username / password / pwd_hash" }, 400);
    }

    const email = `${username}@${EMAIL_DOMAIN}`;

    // 1. 校验旧密码哈希 (防劫持: 必须知道正确密码才能迁移)
    const verify = await callRpc("verify_login", { p_username: username, p_pwd_hash: pwd_hash });
    if (!verify || !verify.success) {
      return json({ success: false, error: "password_verify_failed" }, 403);
    }

    // 2. 在 Supabase Auth 建/取 user (幂等)
    const userResult = await ensureAuthUser(email, password);
    if (!userResult.uid) {
      return json({ success: false, error: userResult.error || "create_auth_user_failed" }, 500);
    }
    const uid = userResult.uid;

    // 3. 回填 user_id 到三张表 (service_role 绕过 RLS)
    //    - user_auth: 绑定账号
    //    - words / records: 按旧 sync_code (= username) 回填, 完成数据归属迁移
    const userEnc = encodeURIComponent(username);
    await patchTable("user_auth", `username=eq.${userEnc}`, { user_id: uid });
    await patchTable("words", `sync_code=eq.${userEnc}`, { user_id: uid });
    await patchTable("records", `sync_code=eq.${userEnc}`, { user_id: uid });

    // 4. 二次确认 user_auth.user_id 已绑定 (防止 PATCH 静默失败)
    const status = await callRpc("get_user_migration_status", { p_username: username });
    if (!status || !status.migrated) {
      return json({ success: false, error: "user_id 回填未生效, 请重试" }, 500);
    }

    console.log(`[migrate-user] ${username} → ${uid} 迁移成功`);
    return json({ success: true, uid });
  } catch (err) {
    console.error("[migrate-user] 异常", err);
    return json({ success: false, error: String(err) }, 500);
  }
});
