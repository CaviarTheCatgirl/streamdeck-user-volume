import streamDeck from "@elgato/streamdeck";

import { UserVolumeAction } from "./actions/user-volume";
import { bridge, DEFAULT_PORT } from "./bridge";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new UserVolumeAction());

// The port lives in the global settings; it is applied whenever they arrive.
streamDeck.settings.onDidReceiveGlobalSettings<{ port?: number; }>(ev => {
    bridge.setPort(Number(ev.settings?.port) || DEFAULT_PORT);
});

// Connect to Discord right away on the default port; a stored port switches over.
bridge.start();

streamDeck.connect().then(() => {
    streamDeck.settings.getGlobalSettings<{ port?: number; }>()
        .then(g => bridge.setPort(Number(g?.port) || DEFAULT_PORT))
        .catch(() => { /* keep the default */ });
});
