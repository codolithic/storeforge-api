export type Menu = {
  id: number;
  name: string;
  slug: string;
  subMenu: Menu[] | null;
};
