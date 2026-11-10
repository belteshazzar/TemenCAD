import SwiftUI

@main
struct MainApp: App {
    @StateObject private var app = AppModel()
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(app)
        }
    }
}
