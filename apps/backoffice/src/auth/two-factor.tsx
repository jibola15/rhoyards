import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Download } from 'lucide-react';
import type { TwoFactorSetup } from '@rhoyards/shared';
import { Button, Checkbox, toast } from '@rhoyards/ui';

/** The QR code to scan, with the key to type in when scanning is not possible. */
export function AuthenticatorSetup({ setup }: { setup: TwoFactorSetup }) {
  return (
    <div className="grid gap-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or similar).</li>
        <li>In the app, add an account and scan this code.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="mx-auto rounded-md bg-white p-3">
        <QRCodeSVG value={setup.otpauthUri} size={176} title="QR code for your authenticator app" />
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Can’t scan it? Enter this key instead:
        <code className="mt-1 block break-all font-mono text-sm text-foreground" aria-label="Set-up key">
          {setup.secret.match(/.{1,4}/g)?.join(' ')}
        </code>
      </p>
    </div>
  );
}

/** One-time backup codes, shown once, with copy and download, and an acknowledgement before moving on. */
export function BackupCodes({ codes, onDone, doneLabel = 'Continue' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const text = `Rhoyards back office — backup codes\nEach code works once.\n\n${codes.join('\n')}\n`;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Keep these somewhere safe, away from your phone. If you lose your phone, each code lets you sign in once. They will not be
        shown again.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm" aria-label="Backup codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => toast.success('Backup codes copied'),
              () => toast.error('Could not copy; select the codes and copy them instead.'),
            );
          }}
        >
          <Copy />
          Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'rhoyards-backup-codes.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download />
          Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have saved my backup codes
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
