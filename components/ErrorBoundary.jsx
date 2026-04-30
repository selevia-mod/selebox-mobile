import { Component } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";
import logger from "../lib/utils/logger";

// App-wide React error boundary. Catches render-time errors anywhere in the
// tree below it, reports them to Crashlytics via the logger, and renders a
// recoverable fallback instead of letting the JS bridge whitescreen.
//
// Why this matters: any uncaught render error (a stale closure, a null
// .map(), a missing prop) tears the whole React tree out and leaves the user
// staring at a blank screen with no way to recover. Adding this boundary at
// the Stack root means the worst case is "tap to reload" instead of "force
// close the app".
//
// Important: this only catches errors that throw during React render /
// lifecycle. It does NOT catch:
//   • Async errors inside useEffect / event handlers — those still need
//     try/catch + logger.error in the call site.
//   • Native crashes — those go straight to Crashlytics.
//   • Errors during initial render of the boundary itself.
//
// The fallback uses hard-coded dark-theme colors instead of the Redux theme
// hook, because the error may have happened before Provider mounted or
// because Redux state is itself the problem.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Stack as breadcrumb context — Crashlytics shows it on the issue page.
    const componentStack = errorInfo?.componentStack ? `\n${errorInfo.componentStack}` : "";
    logger.error("ErrorBoundary", `Render crashed${componentStack}`, error);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const errorMessage = this.state.error?.message || "An unexpected error occurred.";

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.inner}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>
            We hit an unexpected error and had to stop the screen. Tap below to try again — your data is safe.
          </Text>

          {__DEV__ && (
            <View style={styles.devBox}>
              <Text style={styles.devLabel}>DEV ONLY — error message</Text>
              <Text style={styles.devMessage} selectable>
                {errorMessage}
              </Text>
            </View>
          )}

          <Pressable
            onPress={this.handleReset}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
}

// Hard-coded dark colors — see comment in class above for why we don't pull
// from the theme. Matches the Selebox violet brand color (#8b5cf6).
const styles = {
  container: {
    flex: 1,
    backgroundColor: "#111827",
  },
  inner: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: {
    fontSize: 56,
    marginBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#f9fafb",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: "#9ca3af",
    textAlign: "center",
    maxWidth: 320,
    marginBottom: 28,
  },
  devBox: {
    width: "100%",
    maxWidth: 360,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    marginBottom: 24,
  },
  devLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#fca5a5",
    letterSpacing: 1,
    marginBottom: 6,
  },
  devMessage: {
    fontSize: 12,
    fontFamily: "Courier",
    color: "#fecaca",
  },
  button: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: "#8b5cf6",
  },
  buttonPressed: {
    backgroundColor: "#7c3aed",
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ffffff",
  },
};

export default ErrorBoundary;
