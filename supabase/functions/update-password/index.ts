/**
 * 改密/找回密码 Edge Function (v1.9.0 安全加固)
 *
 * 作用: 修改密码时同步更新两处密码存储, 保持一致:
 *   1. Supabase Auth 的 bcrypt 密码 (用 service_role admin updateUser)
 *   2. user_auth.password_hash (前端算的 SHA-256, 供迁移校验兜底)
 *
 * 否则会出现: verify_login(旧哈希) 通过但 supabase signIn(bcrypt) 失败 的不一致。
 *
 * 输入 (JSON body):
 *   {
 *     username,        // 用户名
 *     new_password,    // 新密码明文 (用于 supabase bcrypt; HTTPS 下安全)
 *     new_pwd_hash,    // 新密码的 SHA-256(username+password+salt), 前端算好
 *     verify_type,     // 'password' (改密, 用旧密码校验) | 'sec_answer' (找回, 用密保答案校验)
 *     verify_value     // password 模式=旧pwd_hash; sec_answer 模式=sec_answer_hash
 *   }
 *
 * 安全设计:
 *   - 必须通过旧密码 或 密保答案校验才能改密 (防越权)
 *   - 未迁移用户 (无 supabase 账号) 只改 user_auth, 迁移时用新密码建账号
 *
 * 环境变量 (Supabase 默认注入):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const EMAIL_DOMAIN = "beidanci.local";

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

async function patchUserAuth(username: string, newPwdHash: string): Promise<void> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_auth?username=eq.${encodeURIComponent(username)}`,
    {
      method: "PATCH",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ password_hash: newPwdHash }),
    },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`update user_auth failed: HTTP ${resp.status} ${t}`);
  }
}

/** 按 email 在 auth.users 查 uid */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const resp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&keywords=${encodeURIComponent(email)}`,
    { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const users: Array<{ id: string; email: string }> = data?.users || data || [];
  const hit = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  return hit?.id || null;
}

/** 改 supabase auth 的 bcrypt 密码 (按 uid) */
async function updateAuthPassword(uid: string, newPassword: string): Promise<boolean> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
    method: "PUT",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: newPassword }),
  });
  return resp.ok;
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
    const { username, new_password, new_pwd_hash, verify_type, verify_value } = await req.json();
    if (!username || !new_password || !new_pwd_hash || !verify_type || !verify_value) {
      return json({ success: false, error: "参数不完整" }, 400);
    }
    if (verify_type !== "password" && verify_type !== "sec_answer") {
      return json({ success: false, error: "verify_type 非法" }, 400);
    }

    // 1. 校验旧凭证 (防越权)
    let verifyOk = false;
    let verifyErr = "校验失败";
    if (verify_type === "password") {
      const r = await callRpc("verify_login", { p_username: username, p_pwd_hash: verify_value });
      verifyOk = !!(r && r.success);
      if (!verifyOk) verifyErr = r?.error === "user_not_found" ? "用户不存在" : "原密码错误";
    } else {
      const r = await callRpc("verify_sec_answer", { p_username: username, p_sec_answer_hash: verify_value });
      verifyOk = !!r;
      if (!verifyOk) verifyErr = "密保答案错误或用户不存在";
    }
    if (!verifyOk) {
      return json({ success: false, error: verifyErr }, 403);
    }

    const email = `${username}@${EMAIL_DOMAIN}`;

    // 2. 改 supabase auth bcrypt (未迁移用户无账号则跳过, 迁移时用新密码建账号)
    let authUpdated = false;
    let authErr = "";
    const uid = await findUserIdByEmail(email);
    if (uid) {
      authUpdated = await updateAuthPassword(uid, new_password);
      if (!authUpdated) authErr = "supabase auth 改密失败 (user_auth 已更新, 迁移时以新密码建账号)";
    }
    // uid 为 null = 未迁移用户, 跳过 bcrypt 改密 (无账号可改)

    // 3. 改 user_auth.password_hash (始终保持一致, 供 verify_login / 迁移校验)
    await patchUserAuth(username, new_pwd_hash);

    console.log(`[update-password] ${username} 改密成功 (verify=${verify_type}, authUpdated=${authUpdated})`);
    return json({
      success: true,
      auth_updated: authUpdated,
      ...(authErr ? { warning: authErr } : {}),
    });
  } catch (err) {
    console.error("[update-password] 异常", err);
    return json({ success: false, error: String(err) }, 500);
  }
});
