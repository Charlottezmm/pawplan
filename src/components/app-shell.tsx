"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, CalendarDays, CheckCircle2, Download, PawPrint, Settings, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef } from "react";
import { CatIcon } from "./cat-icon";
import { LogoutButton } from "./logout-button";
import { StatusBadge } from "./ui/primitives";

const navItems = [
  { href: "/today", label: "今天", icon: PawPrint },
  { href: "/plan", label: "计划", icon: CalendarDays },
  { href: "/inbox", label: "收集", icon: Archive },
  { href: "/review", label: "审核", icon: CheckCircle2 },
] as const;

export function AppShell({
  children,
  pendingReviewCount = 0,
  showAdminInvites = false,
}: {
  children: React.ReactNode;
  pendingReviewCount?: number;
  showAdminInvites?: boolean;
}) {
  const pathname = usePathname();
  const accountMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    accountMenuRef.current?.removeAttribute("open");
  }, [pathname]);

  function isActive(href: string) {
    if (href === "/plan") return pathname === href || pathname === "/week" || pathname === "/month" || pathname === "/constraints" || pathname === "/projects" || pathname === "/backlog" || pathname === "/archive";
    if (href === "/review") return pathname === href || pathname === "/reschedule";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function reviewBadge() {
    if (pendingReviewCount <= 0) return null;
    return (
      <StatusBadge tone="accent" className="app-review-badge" aria-label={`${pendingReviewCount} 条待审核`}>
        {pendingReviewCount > 99 ? "99+" : pendingReviewCount}
      </StatusBadge>
    );
  }

  const accountMenu = (
    <details ref={accountMenuRef} className="app-account-menu">
      <summary className="app-account-trigger" role="button" aria-label="账户与设置">
        <UserRound size={19} aria-hidden="true" />
      </summary>
      <div className="app-account-popover">
        <p className="app-account-title">账户与设置</p>
        <Link href="/settings" className="app-account-link">
          <Settings size={17} /> 设置
        </Link>
        <Link href="/import" className="app-account-link">
          <Download size={17} /> 导入
        </Link>
        {showAdminInvites ? (
          <Link href="/admin/invites" className="app-account-link">
            <ShieldCheck size={17} /> 邀请管理
          </Link>
        ) : null}
        <LogoutButton compact />
      </div>
    </details>
  );

  return (
    <div className="app-shell">
      <header className="app-topnav">
        <div className="app-topnav-inner">
          <Link href="/today" className="app-brand" aria-label="PawPlan">
            <CatIcon size={32} />
            <span>PawPlan</span>
          </Link>
          <nav className="app-nav" aria-label="Primary navigation">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className="app-nav-link" aria-current={isActive(item.href) ? "page" : undefined}>
                {item.label}
                {item.href === "/review" ? reviewBadge() : null}
              </Link>
            ))}
          </nav>
          {accountMenu}
        </div>
      </header>
      <div className="app-workspace">
        <main className="app-content">{children}</main>
        <nav className="mobile-tabbar" aria-label="Mobile navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="mobile-tab" aria-current={isActive(item.href) ? "page" : undefined}>
                <span className="mobile-tab-icon">
                  <Icon size={22} strokeWidth={2} />
                  {item.href === "/review" ? reviewBadge() : null}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
