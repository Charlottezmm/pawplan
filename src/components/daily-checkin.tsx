"use client";

import { useState } from "react";
import { CatIcon } from "./cat-icon";

type SaveResponse = {
  streakDays?: number;
  error?: string;
};

type DailyCheckinProps = {
  initialCompletedText?: string;
  initialBlockerText?: string;
  initialNextText?: string;
  initialStreakDays?: number;
  dataUnavailable?: boolean;
};

export function DailyCheckin({
  initialCompletedText = "",
  initialBlockerText = "",
  initialNextText = "",
  initialStreakDays = 0,
  dataUnavailable = false,
}: DailyCheckinProps) {
  const [completedText, setCompletedText] = useState(initialCompletedText);
  const [blockerText, setBlockerText] = useState(initialBlockerText);
  const [nextText, setNextText] = useState(initialNextText);
  const [message, setMessage] = useState<string | null>(initialStreakDays ? `已 ${initialStreakDays} 天连续记录` : null);
  const [pending, setPending] = useState(false);
  const [savedStreak, setSavedStreak] = useState<number | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (dataUnavailable) {
      setMessage("本地数据源未配置，暂时无法保存。");
      return;
    }
    setPending(true);
    const response = await fetch("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completedText, blockerText, nextText }),
    });
    const data = (await response.json()) as SaveResponse;
    setPending(false);
    if (!response.ok) {
      setMessage(data.error ?? "保存失败");
      return;
    }
    setMessage(null);
    setSavedStreak(data.streakDays ?? 1);
  }

  return (
    <form onSubmit={submit} className="paw-feedback-card">
      <div>
        <h2 className="paw-feedback-title">收工反馈</h2>
        <p className="paw-feedback-subtitle">花 5 秒记三件事：做完了什么、卡在哪、明天从哪继续。</p>
        {dataUnavailable ? <p className="paw-feedback-subtitle paw-warning-text">当前没有配置数据库，保存会在真实环境启用。</p> : null}
      </div>
      <div className="paw-feedback-fields">
        <label>
          <span className="paw-field-label">完成</span>
          <textarea
            value={completedText}
            onChange={(event) => setCompletedText(event.target.value)}
            placeholder="今天实际完成了什么"
            rows={2}
            className="paw-textarea"
          />
        </label>
        <label>
          <span className="paw-field-label">卡点</span>
          <textarea
            value={blockerText}
            onChange={(event) => setBlockerText(event.target.value)}
            placeholder="今天卡在哪里"
            rows={2}
            className="paw-textarea"
          />
        </label>
        <label>
          <span className="paw-field-label">明日接</span>
          <textarea
            value={nextText}
            onChange={(event) => setNextText(event.target.value)}
            placeholder="明天从哪里继续"
            rows={2}
            className="paw-textarea"
          />
        </label>
      </div>
      <div className="paw-save-row">
        <button disabled={pending || dataUnavailable} className="paw-save-btn">
          {pending ? "保存中" : "保存反馈"}
        </button>
        {message ? <p className="paw-toast">{message}</p> : null}
      </div>
      {savedStreak !== null ? (
        <div className="paw-streak-pop" role="status">
          <CatIcon size={52} mood="celebrate" />
          <div>
            <p className="paw-streak-num">{savedStreak}</p>
            <p className="paw-streak-label">天连续记录，今天也收工了</p>
          </div>
        </div>
      ) : null}
    </form>
  );
}
