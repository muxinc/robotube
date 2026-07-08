const MUX_VIEW_NOT_FOUND_MESSAGE = "Unable to find the 'MuxVideoView' view with tag";

export function runMuxPlayerCommand(command: Promise<void>) {
  void command.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes(MUX_VIEW_NOT_FOUND_MESSAGE)) {
      return;
    }

    console.warn("Mux player command failed", error);
  });
}
