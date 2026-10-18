import { useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from '@rhoyards/ui';
import { ConfirmDialog } from './ConfirmDialog';

interface ConfirmActionProps {
  children: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  variant?: ButtonProps['variant'];
  destructive?: boolean;
  disabled?: boolean;
}

/** A button that asks for confirmation before running an irreversible action. */
export function ConfirmAction({ children, title, description, confirmLabel, onConfirm, variant, destructive, disabled }: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        destructive={destructive}
        onConfirm={onConfirm}
      />
    </>
  );
}
