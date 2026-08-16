"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, CalendarDays, CheckCircle2, Clock3, MoreHorizontal, PawPrint } from "lucide-react";
import { CatIcon } from "./cat-icon";
import { FloatingCat } from "./floating-cat";

const navItems = [
  { href: "/today", label: "Today" },
  { href: "/plan", label: "Plan" },
  { href: "/constraints", label: "Fixed" },
  { href: "/inbox", label: "Inbox" },
  { href: "/review", label: "Review" },
  { href: "/more", label: "More" },
];

const navIcons = {
  Today: PawPrint,
  Plan: CalendarDays,
  Fixed: Clock3,
  Inbox: Archive,
  Review: CheckCircle2,
  More: MoreHorizontal,
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/plan") return pathname === href || pathname === "/week" || pathname === "/month" || pathname === "/projects" || pathname === "/backlog" || pathname === "/archive";
    if (href === "/review") return pathname === href || pathname === "/reschedule";
    if (href === "/more") return pathname === href || pathname === "/import" || pathname === "/settings";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

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
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="app-workspace">
        <main className="app-content">{children}</main>
        <FloatingCat />
        <nav className="mobile-tabbar" aria-label="Mobile navigation">
          {navItems.map((item) => {
            const Icon = navIcons[item.label as keyof typeof navIcons];
            return (
              <Link key={item.href} href={item.href} className="mobile-tab" aria-current={isActive(item.href) ? "page" : undefined}>
                <Icon size={22} strokeWidth={2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
