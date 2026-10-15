import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; title: string };

/** Keep optional watch-page tools from unmounting the entire application. */
export class RenderErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[RoboTube] ${this.props.title}`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="empty-state" role="alert">
        <h2>{this.props.title}</h2>
        <p>Something went wrong loading this section. Try again or reload the page.</p>
        <button className="button button--pink" type="button" onClick={() => this.setState({ failed: false })}>Try again</button>
        <button className="button button--outline" type="button" onClick={() => window.location.reload()}>Reload page</button>
      </section>
    );
  }
}
