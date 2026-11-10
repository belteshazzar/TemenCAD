import SwiftUI

@main
struct MainApp: App {
    @StateObject private var app = AppModel()
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(app)
                .onOpenURL { app.open(url: $0) } // a .temen from Files, AirDrop or another app's "Open in"
        }
    }
}
