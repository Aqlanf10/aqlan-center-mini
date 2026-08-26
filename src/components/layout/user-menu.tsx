"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";
import type { SessionUser } from "@/lib/auth/guards";
import { useI18n } from "@/i18n/provider";

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

/** Header user menu — profile summary and real sign-out. */
export function UserMenu({ user }: { user: SessionUser }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
      startTransition(() => {
        router.push("/login");
        router.refresh();
      });
    } catch {
      toast.error(dict.errors.generic);
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 px-2"
          aria-label={user.name}
          disabled={signingOut || pending}
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
              {initialsOf(user.name) || "?"}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate font-medium sm:inline">
            {user.name}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="truncate text-sm font-semibold">{user.name}</span>
          <span className="text-muted-foreground truncate text-xs font-normal" dir="ltr">
            @{user.username}
          </span>
          <Badge variant="secondary" className="w-fit">
            {dict.roles[user.role]}
          </Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
          disabled={signingOut}
          className="min-h-9"
        >
          {signingOut ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <LogOutIcon aria-hidden="true" />
          )}
          {signingOut ? dict.auth.signingOut : dict.auth.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
