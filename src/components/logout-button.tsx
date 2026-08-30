"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/primitives";

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState(false);

  async function logout() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 即便请求失败也回登录页，cookie 失效后会被拦截
    } finally {
      window.location.replace("/login");
    }
  }

  if (compact) return (
    <Button
      type="button"
      variant="ghost"
      onClick={logout}
      disabled={pending}
      className="app-account-link app-account-logout"
      aria-busy={pending}
    >
      <LogOut size={17} />
      {pending ? "退出中…" : "退出登录"}
    </Button>
  );

  return (
    <button
      type="button"
      onClick={logout}
      disabled={pending}
      className="paw-more-card w-full text-left"
      aria-busy={pending}
    >
      <span className="paw-more-icon">
        <LogOut size={18} />
      </span>
      <div>
        <h3 className="paw-more-label">{pending ? "退出中…" : "退出登录"}</h3>
        <p className="paw-more-text">退出当前计划空间，回到登录页（切换计划空间也从这里进入）。</p>
      </div>
    </button>
  );
}
