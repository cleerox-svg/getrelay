//  AppDelegate.swift — Relay iOS
//
//  RELAY_APPDELEGATE_INJECTED
//
//  This file REPLACES the AppDelegate that `cap add ios` scaffolds. It is
//  copied into place by .github/workflows/build-ios.yml; ios/ itself is never
//  committed, the same way android/ isn't.
//
//  Why it has to exist
//  -------------------
//  @capacitor/push-notifications returns the raw APNs device token on iOS,
//  but Relay's worker sends through Firebase Cloud Messaging (one sender,
//  one credential, one native_push_tokens table — shared with Android), and
//  FCM cannot address an APNs token. So we let Firebase mint an FCM token
//  from the APNs one and post THAT into Capacitor's registration event.
//
//  The plugin accepts either a Data (APNs, hex-encoded by the plugin) or a
//  String posted to .capacitorDidRegisterForRemoteNotifications, so handing
//  it the FCM token string needs no plugin fork — and src/lib/native-push.ts
//  stays byte-identical across Android and iOS.
//
//  Degrading safely
//  ----------------
//  Everything Firebase is conditional on GoogleService-Info.plist actually
//  being in the bundle (it arrives from the GOOGLE_SERVICE_INFO_PLIST
//  secret). Unset secret → no FirebaseApp.configure() call, so the app does
//  NOT crash on launch; it falls back to posting the APNs token, which the
//  worker rejects with `apns_token_not_fcm` and the Profile toggle shows.
//  That mirrors the Android build's "no google-services.json → still builds,
//  push just doesn't register" behaviour. See IOS-PUSH.md.

import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate {

    var window: UIWindow?

    /// True only when GoogleService-Info.plist shipped in this build.
    /// FirebaseApp.configure() traps at runtime without it, so every Firebase
    /// call below is gated on this rather than assuming the secret was set.
    private var firebaseReady = false

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
            firebaseReady = true
        } else {
            NSLog("[Relay] GoogleService-Info.plist missing — native push (FCM) is not wired into this build")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Keep this call: it's how Capacitor plugins (including the Google
        // Sign-In one, which comes back via a custom URL scheme) receive the
        // callback URL.
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(
        _ application: UIApplication,
        didFailToContinueUserActivityWithType userActivityType: String,
        error: Error
    ) {
    }

    // MARK: - Remote notification registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        guard firebaseReady else {
            // No Firebase in this build. Post the APNs token so the failure is
            // visible and specific (worker → `apns_token_not_fcm`) instead of
            // the app appearing to register and then never receiving anything.
            NotificationCenter.default.post(
                name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
            return
        }

        // Hand APNs' token to Firebase FIRST — Messaging.token() can only mint
        // an FCM token once it knows the APNs one.
        Messaging.messaging().apnsToken = deviceToken

        Messaging.messaging().token { token, error in
            if let error = error {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
            } else if let token = token {
                NotificationCenter.default.post(
                    name: .capacitorDidRegisterForRemoteNotifications, object: token)
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // MARK: - MessagingDelegate

    /// Fires when Firebase rotates the FCM token (restore from backup, app
    /// reinstall, long idle). Re-posting it through the same notification
    /// makes the JS `registration` listener re-POST it to the worker, so a
    /// rotated token doesn't silently stop delivering.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else { return }
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications, object: fcmToken)
    }
}
