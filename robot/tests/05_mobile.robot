*** Settings ***
Documentation     Very small phone screens. Browsers will not shrink a window below ~500px, so the app is loaded
...               in an iframe of the requested width (robot/fixtures/narrow.html): its media queries see that width.
Resource          ../resources/common.resource
Suite Setup       Open Test Browser
Suite Teardown    Close All Browsers
Test Timeout      90s
Force Tags        mobile

*** Test Cases ***
No Horizontal Scrolling On Any Tab At 280px
    Open Narrow App    280
    Every Tab Should Fit The Screen

No Horizontal Scrolling On Any Tab At 240px
    Open Narrow App    240
    Every Tab Should Fit The Screen

The Login Screen Fits At 240px
    Go To    ${BASE_URL}/index.html
    Execute Javascript    window.__mock.reset(); localStorage.clear();
    Go To    ${BASE_URL}/narrow.html?w=240
    Select Frame    id:app
    Wait Until Element Is Visible    id:authScreen
    Page Should Fit The Screen
    Unselect Frame

The Tab Bar Moves To The Bottom On Phones
    Open Narrow App    280
    ${position}=    Execute Javascript    return getComputedStyle(document.querySelector('.tabs')).position;
    Should Be Equal    ${position}    fixed
    ${top}=    Execute Javascript    var r = document.querySelector('.tabs').getBoundingClientRect(); return r.top > window.innerHeight / 2;
    Should Be True    ${top}

Tab Labels Are Hidden Below 300px But The Tabs Stay Usable
    Open Narrow App    240
    ${display}=    Execute Javascript    return getComputedStyle(document.querySelector('.tab-label')).display;
    Should Be Equal    ${display}    none
    ${label}=    Get Element Attribute    css:.tab[aria-controls="savings"]    aria-label
    Should Be Equal    ${label}    Savings
    Open Tab    savings

Tables Become Stacked Cards On Phones
    Open Narrow App    280
    Add Transaction    Salary    income    1000
    ${header}=    Execute Javascript    return getComputedStyle(document.querySelector('#generalTable thead')).position;
    Should Be Equal    ${header}    absolute
    ${display}=    Execute Javascript    return getComputedStyle(document.querySelector('#generalTable tbody tr td')).display;
    Should Be Equal    ${display}    flex
    Page Should Fit The Screen

Buttons And Inputs Are Large Enough To Tap At 280px
    Open Narrow App    280
    Open Tab    general
    ${small}=    Execute Javascript
    ...    var bad = []; document.querySelectorAll('#general .btn, #general input:not([type=checkbox]), #general select').forEach(function (el) { var r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.height < 36) bad.push(el.id || el.className); }); return bad.join(',');
    Should Be Empty    ${small}

*** Keywords ***
Open Narrow App
    [Arguments]    ${width}
    Go To    ${BASE_URL}/index.html
    Execute Javascript    window.__mock.reset(); localStorage.clear();
    Go To    ${BASE_URL}/narrow.html?w=${width}
    Select Frame    id:app
    Wait Until Element Is Visible    id:authScreen
    Log In Successfully

Page Should Fit The Screen
    ${fits}=    Execute Javascript    return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    Should Be True    ${fits}    The page is wider than the screen (horizontal scrolling)

Every Tab Should Fit The Screen
    FOR    ${panel}    IN    dashboard    general    rental    savings    advice
        Open Tab    ${panel}
        Page Should Fit The Screen
    END
