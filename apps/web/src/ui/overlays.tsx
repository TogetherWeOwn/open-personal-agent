// SPDX-License-Identifier: Apache-2.0
// Dialogs and sheets (m3-ux §4.4): RAC traps focus inside and returns it to the trigger on close.
import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from "react-aria-components";
import { Button } from "./Button";

type OverlayProps = Pick<ModalOverlayProps, "isOpen" | "onOpenChange" | "isDismissable"> & {
  title: string;
  children: ReactNode;
};

const overlay = "fixed inset-0 z-20 flex bg-black/40";

/** A centred dialog. Render it inside a RAC `DialogTrigger`, or control it with `isOpen`. */
export function Dialog({ title, children, isDismissable = true, ...props }: OverlayProps) {
  return (
    <ModalOverlay
      {...props}
      isDismissable={isDismissable}
      className={`${overlay} items-center justify-center p-4`}
    >
      <Modal className="w-full max-w-[480px] rounded-xl border border-border bg-surface-raised p-5">
        <AriaDialog className="flex flex-col gap-4 outline-none">
          <Heading slot="title" className="text-xl font-semibold">
            {title}
          </Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** A yes/no dialog. `danger` for anything that deletes; the safe choice comes first. */
export function ConfirmDialog({
  title,
  children,
  confirm,
  cancel = "Cancel",
  danger = false,
  isConfirmDisabled = false,
  onConfirm,
  ...props
}: OverlayProps & {
  confirm: string;
  cancel?: string;
  danger?: boolean;
  isConfirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={title} isDismissable={!danger} {...props}>
      {children}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button slot="close">{cancel}</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          isDisabled={isConfirmDisabled}
          onPress={onConfirm}
        >
          {confirm}
        </Button>
      </div>
    </Dialog>
  );
}

/** A panel from the right edge, or the bottom below 640 px. */
export function Sheet({ title, children, isDismissable = true, ...props }: OverlayProps) {
  return (
    <ModalOverlay
      {...props}
      isDismissable={isDismissable}
      className={`${overlay} items-end sm:justify-end sm:items-stretch`}
    >
      <Modal className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-5 sm:max-h-none sm:w-[420px] sm:rounded-none sm:border-y-0 sm:border-r-0">
        <AriaDialog className="flex flex-col gap-4 outline-none">
          <div className="flex items-center justify-between gap-2">
            <Heading slot="title" className="text-xl font-semibold">
              {title}
            </Heading>
            <Button slot="close" variant="quiet">
              Close
            </Button>
          </div>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
