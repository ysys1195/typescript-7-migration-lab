declare global {
  namespace JSX {
    interface IntrinsicElements {
      button: { disabled?: boolean; children?: unknown };
      section: { children?: unknown };
    }
  }
}

type Props = {
  title: string;
  pending?: boolean;
};

export function Panel(props: Props) {
  return (
    <section>
      {props.title}
      <button disabled={props.pending}>Save</button>
    </section>
  );
}
