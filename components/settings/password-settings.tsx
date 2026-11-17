"use client";
import { useState, type FormEvent } from "react";

export function PasswordSettings() {
 const [currentPassword, setCurrentPassword] = useState("");
 const [newPassword, setNewPassword] = useState("");
 const [confirmPassword, setConfirmPassword] = useState("");
 const [busy, setBusy] = useState(false);
 const [message, setMessage] = useState("");
 const [saved, setSaved] = useState(false);
 async function submit(event: FormEvent) {
  event.preventDefault(); setMessage(""); setSaved(false);
  if (newPassword !== confirmPassword) { setMessage("New passwords must match."); return; }
  if (newPassword.length < 12 || new TextEncoder().encode(newPassword).length > 72) { setMessage("Use at least 12 characters and at most 72 bytes."); return; }
  setBusy(true);
  try {
   const response = await fetch("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
   const body = await response.json();
   if (!response.ok) { setMessage(body.error ?? "Could not change the password."); return; }
   setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setSaved(true);
   setMessage("Password changed. Your browser will ask you to sign in again with your new password.");
  } catch { setMessage("Could not change the password. Please try again."); }
  finally { setBusy(false); }
 }
 return <form onSubmit={submit} className="space-y-3 border-t border-border px-1 py-5" aria-label="Change sign-in password">
  <h3 className="text-sm font-medium">Sign-in password</h3>
  <p className="text-xs text-muted-foreground">Change the password used to access this hosted app. Use at least 12 characters (72 bytes maximum).</p>
  {([
   ["Current password", currentPassword, setCurrentPassword, "current-password"],
   ["New password", newPassword, setNewPassword, "new-password"],
   ["Confirm new password", confirmPassword, setConfirmPassword, "new-password"],
  ] as const).map(([label, value, setter, autoComplete]) => <label key={label} className="block text-xs">{label}<input type="password" required autoComplete={autoComplete} value={value} disabled={busy} onChange={e => setter(e.target.value)} className="mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" /></label>)}
  <button type="submit" disabled={busy} className="rounded-sm border border-border px-3 py-2 text-xs disabled:opacity-50">{busy ? "Changing…" : "Change password"}</button>
  {message && <p role={saved ? "status" : "alert"} className="text-xs">{message}</p>}
 </form>;
}
