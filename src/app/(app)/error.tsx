"use client";

import Link from "next/link";
import React, { useEffect } from "react";
import { CatIcon } from "@/components/cat-icon";
import { Button, EmptyState } from "@/components/ui/primitives";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="paw-page paw-page-narrow" role="alert" aria-live="assertive">
      <EmptyState
        title="这一页暂时没打开"
        description="页面没有确认任何新的改动；如果你刚进行过操作，请刷新后核对最终状态。"
        action={(
          <>
            <CatIcon mood="sorry" size={48} />
            <div className="paw-review-bottom">
              <Button type="button" onClick={reset}>再试一次</Button>
              <Link href="/today" className="paw-ui-button paw-ui-button-secondary">
                回到今天
              </Link>
            </div>
          </>
        )}
      />
    </div>
  );
}
