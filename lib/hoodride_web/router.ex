defmodule HoodrideWeb.Router do
  use HoodrideWeb, :router

  # every HTTP endpoint: who is signed in — decided on the server
  # (HoodrideWeb.Auth) — then its budget, per account or per address
  # (HoodrideWeb.HttpBudget)
  pipeline :api do
    plug :accepts, ["json"]
    plug :fetch_session
    plug HoodrideWeb.CurrentUser
    plug HoodrideWeb.HttpBudget
  end

  # sign-in (/auth/*): its OWN budget, so it can't use up the app's
  # (AuthController has the refresh and failed-code limits)
  pipeline :session do
    plug :fetch_session
    plug HoodrideWeb.CurrentUser
    plug HoodrideWeb.HttpBudget, config: :sign_in_budget, name: :sign_in
  end

  # profile photos (HoodrideWeb.AvatarController): signed-in only, with
  # their own budget
  pipeline :avatar do
    plug :fetch_session
    plug HoodrideWeb.CurrentUser
    plug HoodrideWeb.HttpBudget, config: :avatar_budget, name: :avatar
  end

  scope "/avatars", HoodrideWeb do
    pipe_through :avatar

    get "/:name", AvatarController, :show
  end

  scope "/api", HoodrideWeb do
    pipe_through :api

    get "/me", AuthController, :me
    get "/state", AuthController, :state
    get "/socket_token", AuthController, :socket_token
    post "/logout", AuthController, :logout
    post "/terms/accept", AuthController, :accept_terms
    post "/account/delete", AuthController, :delete_account
    get "/car", CarController, :show
    post "/car", CarController, :update
    post "/dev_login", AuthController, :dev_login
    # what the Content-Security-Policy blocked (HoodrideWeb.CSP)
    post "/csp-report", CspReportController, :create
    match :*, "/*path", AuthController, :not_found
  end

  scope "/auth", HoodrideWeb do
    pipe_through :session

    get "/:provider", AuthController, :request
    get "/:provider/callback", AuthController, :callback
  end

  # the PWA itself. Any other path: the app too — typos and stray links
  # land on the map — but with a real 404 (it doesn't exist: Google's
  # guidance; PageController.not_found). /index.html is real: the offline
  # copy downloads it (sw.js ASSETS)
  scope "/", HoodrideWeb do
    get "/", PageController, :index
    get "/index.html", PageController, :english_index
    get "/sw.js", PageController, :service_worker
    get "/privacy", PageController, :privacy
    get "/terms", PageController, :terms
    # every page's address, for search engines (robots.txt names it)
    get "/sitemap.xml", PageController, :sitemap
    # the crawl rules (priv/static/robots.txt) and the sitemap's full address
    get "/robots.txt", PageController, :robots
    # each language's own addresses (owner, 2026-11-05): /ja, /ja/privacy,
    # /ja/terms — a language that isn't switched on: not found
    get "/:lang", PageController, :lang_index
    get "/:lang/privacy", PageController, :lang_privacy
    get "/:lang/terms", PageController, :lang_terms
    get "/*path", PageController, :not_found
  end
end
