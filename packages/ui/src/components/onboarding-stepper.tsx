import type { ReactNode } from 'react'
import { cn } from '@keyring/ui/lib/utils'
import { SolarIcon } from '@keyring/ui/components/solar-icon'

export interface OnboardingStep<StepId extends string> {
  id: StepId
  title: string
  description: ReactNode
}

interface OnboardingStepperProps<StepId extends string> {
  steps: readonly OnboardingStep<StepId>[]
  currentStepIndex: number
  onStepSelect?: (step: StepId) => void
  stepDescriptions?: Partial<Record<StepId, ReactNode>>
  tone?: 'default' | 'inverse'
}

export function OnboardingStepper<StepId extends string>({
  steps,
  currentStepIndex,
  onStepSelect,
  stepDescriptions,
  tone = 'default',
}: OnboardingStepperProps<StepId>) {
  const inverse = tone === 'inverse'

  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const isCompleted = index < currentStepIndex
        const isCurrent = index === currentStepIndex
        const isClickable = isCompleted && Boolean(onStepSelect)
        const isLast = index === steps.length - 1

        return (
          <li
            key={step.id}
            className={cn(
              'flex gap-4',
              isClickable && 'cursor-pointer opacity-100 transition-opacity hover:opacity-70',
            )}
            onClick={isClickable ? () => onStepSelect?.(step.id) : undefined}
          >
            <span className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  inverse
                    ? isCompleted || isCurrent
                      ? 'bg-white text-black'
                      : 'border border-white/30 text-white/60'
                    : isCompleted || isCurrent
                      ? 'bg-ink text-canvas'
                      : 'border border-hairline text-ink-muted',
                )}
              >
                <span className="type-mono">
                  {isCompleted ? (
                    <SolarIcon name="check" className="h-3.5 w-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
              </span>
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    'w-px flex-1',
                    inverse ? 'bg-white/25' : 'bg-hairline',
                  )}
                />
              )}
            </span>
            <span className={cn('flex min-w-0 flex-1 flex-col', !isLast && 'pb-8')}>
              <span className="flex w-full items-center justify-between gap-3">
                <span
                  className={cn(
                    'type-body-sm font-medium',
                    inverse ? 'text-white' : 'text-ink',
                  )}
                >
                  {step.title}
                </span>
                {isCurrent ? (
                  <span
                    className={cn(
                      'type-mono shrink-0 rounded-full px-2.5 py-0.5',
                      inverse ? 'bg-white/15 text-white' : 'bg-pillar text-ink-navy',
                    )}
                  >
                    In Progress
                  </span>
                ) : !isCompleted ? (
                  <span
                    className={cn(
                      'type-mono shrink-0 rounded-full px-2.5 py-0.5',
                      inverse
                        ? 'border border-white/25 text-white/55'
                        : 'border border-hairline text-ink-muted',
                    )}
                  >
                    Pending
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  'type-body-sm mt-0.5',
                  inverse ? 'text-white/65' : 'text-ink-muted',
                )}
              >
                {isCompleted
                  ? (stepDescriptions?.[step.id] ?? step.description)
                  : step.description}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
