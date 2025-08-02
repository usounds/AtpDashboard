import { ReactNode, useState } from 'react';

interface SidebarLinkGroupProps {
  children: (handleClick: () => void, open: boolean) => ReactNode;
  activeCondition: boolean;
  defaultOpen?: boolean;
}

const SidebarLinkGroup = ({
  children,
  activeCondition,
  defaultOpen,
}: SidebarLinkGroupProps) => {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? activeCondition);

  const handleClick = () => {
    setOpen(!open);
  };

  return <li>{children(handleClick, open)}</li>;
};

export default SidebarLinkGroup;
