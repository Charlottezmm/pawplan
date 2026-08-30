import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export function BackLink({ href = "/more", label = "返回" }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="paw-back">
      <ChevronLeft size={16} />
      <span>{label}</span>
    </Link>
  );
}
