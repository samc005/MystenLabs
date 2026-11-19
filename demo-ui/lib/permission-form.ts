// Turns the settings form into owner edits. Kept out of the page so it can be tested without React.
//
// Empty caps mean "not set on-chain". Zero is a real value on-chain (it blocks spending), so the
// form never uses zero as a placeholder for "unset".

import { parseToMist } from "@mysten/sui/utils";
import { formatSui } from "./sui";
import { normalizeRecipients, type PolicyChanges, type VaultPolicy, validatePolicyChanges } from "./owner-tx";

/** The permission fields as the owner types them. */
export interface PermissionForm {
  perTx: string;
  spendCap: string;
  enforce: boolean;
  dayCap: string;
  weekCap: string;
  recipients: string[];
  newRecipient: string;
}

function parseSuiOrThrow(text: string, label: string): bigint {
  try {
    return parseToMist(text);
  } catch {
    throw new Error(`${label} must be an amount of SUI, like 0.5.`);
  }
}

function requireSui(text: string, label: string): bigint {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return parseSuiOrThrow(trimmed, label);
}

function optionalSui(text: string, label: string): bigint | null {
  const trimmed = text.trim();
  return trimmed ? parseSuiOrThrow(trimmed, label) : null;
}

/** The form as the chain currently has it. */
export function formFrom(policy: VaultPolicy): PermissionForm {
  return {
    perTx: formatSui(policy.perTxLimitMist),
    spendCap: policy.spend ? formatSui(policy.spend.dailyCapMist) : "",
    enforce: policy.spend?.enforceRecipients ?? false,
    dayCap: policy.calendar ? formatSui(policy.calendar.dayCapMist) : "",
    weekCap: policy.calendar ? formatSui(policy.calendar.weekCapMist) : "",
    recipients: [...policy.allowedRecipients],
    newRecipient: "",
  };
}

/**
 * The sections of the form that differ from the chain, ready for buildPolicyUpdateTx.
 * Throws a user-readable error for bad input, including "Nothing to change."
 */
export function changesFor(form: PermissionForm, policy: VaultPolicy): PolicyChanges {
  const changes: PolicyChanges = {};

  const perTx = requireSui(form.perTx, "Per-transaction limit");
  if (perTx !== policy.perTxLimitMist) changes.perTxLimitMist = perTx;

  // set_spend_policy sets the cap and the recipient rule together, so one changed field resends both.
  const spendCap = optionalSui(form.spendCap, "Per-epoch spend cap");
  if (policy.spend) {
    if (spendCap === null) throw new Error("Per-epoch spend cap is required. Enter 0 to block direct spends.");
    if (spendCap !== policy.spend.dailyCapMist || form.enforce !== policy.spend.enforceRecipients) {
      changes.spend = { dailyCapMist: spendCap, enforceRecipients: form.enforce };
    }
  } else if (spendCap !== null) {
    changes.spend = { dailyCapMist: spendCap, enforceRecipients: form.enforce };
  } else if (form.enforce) {
    throw new Error("Set a per-epoch spend cap before limiting payments to trusted recipients.");
  }

  // set_calendar_policy needs both caps, so the pair is always sent together.
  const dayCap = optionalSui(form.dayCap, "Daily cap");
  const weekCap = optionalSui(form.weekCap, "Weekly cap");
  if (policy.calendar) {
    if (dayCap === null || weekCap === null) throw new Error("Enter both the daily and weekly caps. Enter 0 to block spending.");
    if (dayCap !== policy.calendar.dayCapMist || weekCap !== policy.calendar.weekCapMist) {
      changes.calendar = { dayCapMist: dayCap, weekCapMist: weekCap };
    }
  } else if (dayCap !== null || weekCap !== null) {
    if (dayCap === null || weekCap === null) throw new Error("Enter both the daily and weekly caps.");
    changes.calendar = { dayCapMist: dayCap, weekCapMist: weekCap };
  }

  const desired = normalizeRecipients(form.recipients);
  changes.allowRecipients = desired.filter((address) => !policy.allowedRecipients.includes(address));
  changes.disallowRecipients = policy.allowedRecipients.filter((address) => !desired.includes(address));

  return validatePolicyChanges(changes);
}
