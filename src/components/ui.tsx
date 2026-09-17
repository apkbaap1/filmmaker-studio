import { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const sizes = { sm: "px-2.5 py-1.5 text-sm", md: "px-4 py-2 text-sm" };
  const variants = {
    primary: "bg-accent text-accent-foreground hover:brightness-110",
    secondary: "bg-surface-2 text-foreground border border-border hover:bg-border/40",
    danger: "bg-red-950 text-red-300 border border-red-900 hover:bg-red-900/50",
    ghost: "text-muted hover:text-foreground hover:bg-surface-2",
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} {...props} />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60",
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60",
        className
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/60",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cx("mb-1 block text-xs font-medium text-muted", className)} {...props} />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-lg border border-border bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
    </div>
  );
}

export function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-2 text-sm text-red-400">{message}</p>;
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "accent" | "green" | "red" }) {
  const tones = {
    default: "bg-surface-2 text-muted",
    accent: "bg-accent/15 text-accent",
    green: "bg-emerald-500/15 text-emerald-400",
    red: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}
