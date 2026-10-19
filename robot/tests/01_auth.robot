*** Settings ***
Documentation     Signing in, staying signed in, and signing out.
Resource          ../resources/common.resource
Suite Setup       Open Test Browser
Suite Teardown    Close All Browsers
Test Setup        Reset App
Test Timeout      60s
Force Tags        auth

*** Test Cases ***
Visitor Sees Only The Login Screen
    Element Should Be Visible    id:authScreen
    Element Should Not Be Visible    id:mainApp
    Element Should Be Visible    id:authEmail
    Element Should Be Visible    id:registerBtn

Wrong Password Shows An Error And Stays Signed Out
    Login As    ${USER_EMAIL}    not-the-password
    Wait Until Element Contains    id:authMessage    Invalid login credentials
    Element Should Not Be Visible    id:mainApp

Valid Login Opens The App And Shows The User
    Log In Successfully
    Element Text Should Be    id:userEmail    ${USER_EMAIL}
    Element Should Not Be Visible    id:authScreen

Logout Returns To The Login Screen
    Log In Successfully
    Log Out
    Element Should Not Be Visible    id:mainApp

User Stays Signed In After Reloading The Page
    Log In Successfully
    Reload Page
    Wait Until Element Is Visible    id:mainApp
    Element Should Not Be Visible    id:authScreen

Existing Account With A Short Password Can Still Log In
    [Documentation]    The 10-character rule applies to new accounts only.
    Log In Successfully    ${LEGACY_EMAIL}    ${LEGACY_PASSWORD}

Creating An Account Needs A Password Of At Least 10 Characters
    Input Text    id:authEmail    new.person@example.com
    Input Password    id:authPassword    short
    Click Button    id:registerBtn
    Wait Until Element Contains    id:authMessage    at least 10 characters

Creating An Account With A Long Enough Password Is Accepted
    Input Text    id:authEmail    new.person@example.com
    Input Password    id:authPassword    long-enough-password
    Click Button    id:registerBtn
    Wait Until Element Contains    id:authMessage    Account created

Every Tab Can Be Opened
    Log In Successfully
    FOR    ${panel}    IN    general    rental    savings    advice    dashboard
        Open Tab    ${panel}
        Element Should Be Visible    id:${panel}
    END
