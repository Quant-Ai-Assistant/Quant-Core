import { Plural, Trans } from "@lingui/react/macro";
import type { ClaudeCodeBlock } from "@rakazo/contracts";
import { claudeCodeStepCount } from "@rakazo/core";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";
import { ChevronRight } from "lucide-react";
import { activityIcon, activityLabel, activityStepLabel } from "../lib/activity-label";
import { formatToolActivityDuration } from "../lib/tool-activity-view";
import { Shimmer } from "./ai/primitives";

/** While Claude Code works, the list shows only its latest steps. */
const LIVE_STEP_WINDOW = 5;

function StepRow({ step, current }: { step: ClaudeCodeBlock["steps"][number]; current: boolean }) {
  const Icon = activityIcon(step.status.kind);
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px] leading-5">
      <span
        aria-hidden
        className={`w-3 shrink-0 text-center text-[12px] ${current ? "text-warning" : "text-success"}`}
      >
        {current ? "◷" : "✓"}
      </span>
      <Icon size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-muted-foreground" />
      <span
        className={`min-w-0 flex-1 truncate ${current ? "text-foreground" : "text-muted-foreground"}`}
      >
        {current ? activityLabel(step.status.kind) : activityStepLabel(step.status.kind)}
        {step.status.detail ? (
          <span className="ms-1.5 font-mono text-[12px] text-muted-foreground" dir="auto">
            {step.status.detail}
          </span>
        ) : null}
        {step.count > 1 ? ` ×${step.count}` : ""}
      </span>
    </div>
  );
}

/** One Claude Code run in the chat: the step it is on, then a folded list once it is done. */
export function ClaudeCodeCard({ block }: { block: ClaudeCodeBlock }) {
  const live = block.status === "running";
  const count = claudeCodeStepCount(block);
  const duration = formatToolActivityDuration(block.durationMs);
  const current = block.current;
  const CurrentIcon = current ? activityIcon(current.kind) : null;
  const hidden = live ? Math.max(0, block.steps.length - LIVE_STEP_WINDOW) : 0;
  const shown = block.steps.slice(hidden);
  const lastStep = block.steps.at(-1);
  // The current step is the last listed one while it runs; thinking and writing are not listed.
  const currentListed = live && current && lastStep && current.kind === lastStep.status.kind;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground text-[8.5px] font-bold text-background"
      >
        CC
      </span>
      <span className="text-foreground">Claude Code</span>
      {block.model ? <span className="truncate">· {block.model}</span> : null}
    </span>
  );

  return (
    <Card size="sm" className="w-[min(30rem,100%)] max-w-full" data-testid="claude-code-card">
      <CardContent className="flex flex-col gap-2">
        {live ? (
          <>
            {header}
            {current && CurrentIcon ? (
              <div className="flex min-w-0 items-center gap-2 text-[14px]" aria-live="polite">
                <CurrentIcon size={15} strokeWidth={1.8} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">
                  <Shimmer>{activityLabel(current.kind)}</Shimmer>
                </span>
                {current.detail ? (
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">
                    {current.detail}
                  </span>
                ) : null}
              </div>
            ) : null}
            {shown.length > 0 ? (
              <div className="flex flex-col gap-0.5 border-t border-border pt-2">
                {hidden > 0 ? (
                  <div className="text-[12px] text-muted-foreground">
                    <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
                  </div>
                ) : null}
                {shown.map((step, index) => (
                  <StepRow
                    key={hidden + index}
                    step={step}
                    current={Boolean(currentListed) && index === shown.length - 1}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {header}
              <span className="text-[12.5px] text-muted-foreground">
                ·{" "}
                {block.status === "failed" ? (
                  <span className="text-destructive">
                    <Trans>Couldn’t finish</Trans>
                  </span>
                ) : block.status === "cancelled" ? (
                  <Trans>Stopped</Trans>
                ) : (
                  <Plural value={count} one="# step" other="# steps" />
                )}
                {duration ? ` · ${duration}` : null}
              </span>
              <ChevronRight
                aria-hidden
                size={13}
                strokeWidth={1.8}
                className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
            </summary>
            <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
              {block.steps.map((step, index) => (
                <StepRow key={index} step={step} current={false} />
              ))}
              {block.error ? (
                <p className="mt-1 text-[12.5px] text-destructive" dir="auto">
                  {block.error}
                </p>
              ) : null}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
