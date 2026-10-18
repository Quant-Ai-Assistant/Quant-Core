import "expo-router/entry";
import { AppRegistry } from "react-native";
import { AssistantRoot } from "./components/assistant-sheet";

// Android's assistant activity renders this root over the current app, beside the router.
AppRegistry.registerComponent("quantAssistant", () => AssistantRoot);
