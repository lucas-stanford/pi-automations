import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; children: ReactNode }>(function Button({ children, variant = 'default', ...props }, ref) {
  return (
    <button {...props} ref={ref} className={`am-button am-button--${variant} ${props.className ?? ''}`.trim()}>
      {children}
    </button>
  );
});
