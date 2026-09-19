'use client'

import { useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { Button } from '@keyring/ui/components/button'
import { Input } from '@keyring/ui/components/input'
import { SolarIcon } from '@keyring/ui/components/solar-icon'

export function CopyToClipboardInput({
  value,
  onCopy,
  buttonLabel,
  disabled = false,
  className = '',
  variant = 'default',
  ariaLabel,
}: {
  value: string
  onCopy?: () => void
  buttonLabel?: string
  disabled?: boolean
  className?: string
  variant?: 'default' | 'mono'
  ariaLabel?: string
}) {
  const [isCopied, setIsCopied] = useState(false)

  const copyToClipboard = () => {
    void navigator.clipboard.writeText(value ?? '')

    if (onCopy) {
      onCopy()
    }

    setIsCopied(true)

    setTimeout(() => {
      setIsCopied(false)
    }, 2000)
  }

  return (
    <div
      className={twMerge(
        'flex w-full flex-row items-center overflow-hidden rounded-full border border-hairline bg-canvas shadow-xs dark:border-polar-700 dark:bg-polar-800',
        className,
      )}
    >
      <Input
        className={twMerge(
          'w-full grow border-none bg-transparent shadow-none focus-visible:ring-transparent dark:bg-transparent dark:focus-visible:ring-transparent',
          variant === 'mono' ? 'font-mono text-sm' : '',
        )}
        value={value ?? ''}
        readOnly={true}
        aria-label={ariaLabel}
      />
      {!disabled && (
        <Button
          className="mr-1 text-xs"
          type="button"
          size="sm"
          variant="ghost"
          onClick={copyToClipboard}
        >
          {isCopied ? (
            <SolarIcon name="check" className="h-4 w-4" />
          ) : (
            (buttonLabel || 'Copy')
          )}
        </Button>
      )}
    </div>
  )
}
