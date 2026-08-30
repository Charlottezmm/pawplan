"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  { href: "/plan", label: "任务" },
  { href: "/constraints", label: "日程" },
  { href: "/projects", label: "项目" },
  { href: "/backlog", label: "稍后处理" },
  { href: "/archive", label: "归档" },
] as const;

export function PlanSectionNav() {
  const pathname = usePathname();

  return (
    <nav className="paw-plan-section-nav" aria-label="计划分类">
      {sections.map((section) => {
        const active = section.href === "/plan"
          ? pathname === "/plan" || pathname === "/week" || pathname === "/month" || pathname === "/reschedule"
          : pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            className="paw-plan-section-link"
            aria-current={active ? "page" : undefined}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
