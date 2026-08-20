import SwiftUI

@main
struct ServiceDeskApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .onOpenURL { url in
                    appState.handleDeepLink(url)
                }
                .task {
                    appState.setAppForeground(scenePhase == .active)
                }
                .onChange(of: scenePhase) { phase in
                    appState.setAppForeground(phase == .active)
                }
        }
    }
}
