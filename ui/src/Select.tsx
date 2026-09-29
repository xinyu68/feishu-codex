import { Children, Fragment, isValidElement, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value' | 'defaultValue' | 'multiple' | 'size'> & {
  value: string;
  children: ReactNode;
  icon?: ReactNode;
};
type OptionProps = { value?: string; disabled?: boolean; children?: ReactNode };

function selectedLabel(children: ReactNode, value: string): ReactNode {
  const options: OptionProps[] = [];
  const visit = (nodes: ReactNode) => Children.forEach(nodes, child => {
    if (!isValidElement<OptionProps>(child)) return;
    if (child.type === 'option') options.push(child.props);
    else if (child.type === Fragment || child.type === 'optgroup') visit(child.props.children);
  });
  visit(children);
  return (options.find(option => option.value === value) || options.find(option => !option.disabled))?.children ?? value;
}

export function Select({ value, children, icon, className = '', ...props }: SelectProps) {
  return <select {...props} className={`app-select ${className}`.trim()} value={value}>
    <button type="button" tabIndex={-1} className="app-select-trigger" aria-hidden="true">
      {icon && <span className="app-select-icon" aria-hidden="true">{icon}</span>}
      <span className="app-select-label">{selectedLabel(children, value)}</span>
      <ChevronDown className="app-select-chevron" size={13} aria-hidden="true" />
    </button>
    {children}
  </select>;
}
