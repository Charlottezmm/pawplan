import Link from "next/link";
import React from "react";
import { CatIcon } from "@/components/cat-icon";
import { EmptyState } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <main className="paw-login">
      <EmptyState
        className="paw-login-card"
        title="这里没有这个页面"
        description="地址可能写错了，或者页面已经移动。"
        action={(
          <>
            <CatIcon mood="think" size={48} />
            <div>
              <Link href="/today" className="paw-ui-button paw-ui-button-primary">
                回到今天
              </Link>
            </div>
          </>
        )}
      />
    </main>
  );
}
