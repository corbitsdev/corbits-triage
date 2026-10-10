import { Fragment, type ReactNode } from "react";

/** Items as prose: "a", "a and b", "a, b and c". */
export default function Joined({ items, joiner }: { items: Array<{ key: string; node: ReactNode }>; joiner: "and" | "or" }) {
  return items.map((item, i) => (
    <Fragment key={item.key}>
      {i === 0 ? null : i === items.length - 1 ? ` ${joiner} ` : ", "}
      {item.node}
    </Fragment>
  ));
}
